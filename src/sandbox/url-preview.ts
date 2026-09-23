import type { PreviewState } from './preview'
import { IncomingRequest } from './incoming-request'
import type { WorkerWebSocket } from './worker-websocket'
import {abortableWait} from './abortable-wait'
import {previewRequestTimeout,previewStartupTimeout,type PreviewTimeoutOptions} from './request-timeouts'

const leasedOrigins = new Set<string>()
type PreviewServer = {fetch(request: Request): Promise<Response>}
type ConnectWebSocket = (url:string,protocols:string[])=>Promise<WorkerWebSocket>
type DocumentBoot={url:string;clientId?:string;finish(error?:Error):void}
const previewPolicy=(scriptOrigins:string[],connectOrigins:string[])=>
  `default-src 'none'; script-src 'self' 'unsafe-inline'${scriptOrigins.length?' '+scriptOrigins.join(' '):''}; style-src 'self' 'unsafe-inline'; connect-src 'self'${connectOrigins.length?' '+connectOrigins.join(' '):''}; img-src 'self' data: blob:; font-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`
function allowedOrigins(values:string[]|undefined,kind:'script'|'connect'){
  if(values===undefined)return []
  if(!Array.isArray(values)||values.length>16)throw Error(`Invalid preview ${kind} origins`)
  const origins=[] as string[]
  for(const value of values){
    let url:URL
    try{url=new URL(value)}catch{throw Error(`Invalid preview ${kind} origin`)}
    if(url.protocol!=='https:'||url.username||url.password||url.origin!==value.replace(/\/$/,''))throw Error(`Preview ${kind} origins must be exact HTTPS origins`)
    if(!origins.includes(url.origin))origins.push(url.origin)
  }
  return origins
}
function corsExternalScripts(html:string,origins:string[]){
  if(!origins.length)return html
  return html.replace(/<script\b([^>]*)>/gi,(tag,attributes:string)=>{
    if(/\bcrossorigin(?:\s*=|\s|$)/i.test(attributes))return tag
    const source=/\bsrc\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2]
    if(!source)return tag
    let origin:string
    try{origin=new URL(source).origin}catch{return tag}
    return origins.includes(origin)?tag.slice(0,-1)+' crossorigin="anonymous">':tag
  })
}
const types: Record<string, string> = {
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
}

export class URLPreview {
  readonly frame = document.createElement('iframe')
  readonly diagnostics: string[] = []
  readonly requests: { method: string; pathname: string; status: number }[] = []
  readonly origin: string
  #bridge = document.createElement('iframe')
  #owner = new MessageChannel()
  #control?: MessagePort
  #closed = false
  #inspectionListener?: (event: MessageEvent) => void
  #documentBoot?:DocumentBoot
  #nextId = 1
  #pending = new Map<
    number,
    {
      resolve(value: PreviewState & { url: string }): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  #assets: Record<string, Uint8Array>
  #socketDocument?:MessagePort
  #sockets=new Set<()=>void>()
  #previousSockets=new Set<()=>void>()
  #reloadHandoff:string[]=[]
  #socketPending=0
  #requests=new Set<AbortController>()
  #socketListener=(event:MessageEvent)=>{
    if(this.#closed||!this.connectWebSocket||event.source!==this.frame.contentWindow||event.origin!==this.origin||event.data?.type!=='sandbox-websocket-document'||!event.ports[0])return
    this.#socketDocument?.close()
    for(const close of this.#previousSockets)close()
    this.#previousSockets=this.#sockets
    this.#sockets=new Set()
    const documentPort=event.ports[0];this.#socketDocument=documentPort
    documentPort.onmessage=event=>{
      if(event.data?.type==='connect'&&event.ports[0])void this.#openWebSocket(event.data,event.ports[0],documentPort)
    }
  }

  private constructor(
    readonly server: PreviewServer,
    origin: string,
    assets: Record<string, Uint8Array>,
    readonly connectWebSocket?:ConnectWebSocket,
    readonly requestTimeoutMs=previewRequestTimeout(),
    readonly startupTimeoutMs=previewStartupTimeout(),
    readonly policy=previewPolicy([],[]),
    readonly scriptOrigins:string[]=[],
  ) {
    this.origin = origin
    this.#assets = Object.fromEntries(
      Object.entries(assets).map(([path, bytes]) => [path, bytes.slice()]),
    )
  }

  static async mount(
    container: HTMLElement,
    options: {
      origin: string
      server: PreviewServer
      assets?: Record<string, Uint8Array>
      path?: string
      connectWebSocket?:ConnectWebSocket
      scriptOrigins?:string[]
      connectOrigins?:string[]
    }&PreviewTimeoutOptions,
  ) {
    const requestTimeoutMs=previewRequestTimeout(options.requestTimeoutMs)
    const startupTimeoutMs=previewStartupTimeout(options.startupTimeoutMs)
    const origin = new URL(options.origin).origin
    const url = new URL(origin)
    if (
      origin === location.origin ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('Preview requires a separate HTTPS or loopback origin')
    if (leasedOrigins.has(origin))
      throw new Error('Preview origin already leased')
    const scriptOrigins=allowedOrigins(options.scriptOrigins,'script')
    const policy=previewPolicy(scriptOrigins,allowedOrigins(options.connectOrigins,'connect'))
    const preview = new URLPreview(options.server, origin, options.assets ?? {},options.connectWebSocket,requestTimeoutMs,startupTimeoutMs,policy,scriptOrigins)
    leasedOrigins.add(origin)
    try {
      await preview.#boot(container, options.path ?? '/')
      return preview
    } catch (error) {
      preview.close()
      throw error
    }
  }

  async #boot(container: HTMLElement, path: string) {
    if(this.connectWebSocket)addEventListener('message',this.#socketListener)
    // WebKit reports the `hidden` presentational rule against the framed
    // document's strict CSP. Keep the bridge out of the layout without adding
    // a stylesheet or weakening that document's policy.
    this.#bridge.width = '0'
    this.#bridge.height = '0'
    this.#bridge.setAttribute('aria-hidden', 'true')
    this.#bridge.title = 'Workspace request bridge'
    this.#bridge.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    this.#bridge.src = this.origin + '/__sandbox/bridge.html'
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Preview origin bootstrap timed out')),
        10000,
      )
      this.#owner.port1.onmessage = (event) => {
        if (event.data.type === 'ready') {
          clearTimeout(timer)
          resolve()
        } else if (event.data.type === 'error') {
          clearTimeout(timer)
          reject(new Error(event.data.error))
        } else if (event.data.type === 'request' && event.ports[0])
          void this.#request(event.data, event.ports[0])
      }
      this.#bridge.onload = () => {
        this.#bridge.onload = null
        this.#bridge.contentWindow!.postMessage(
          { type: 'attach-workspace' },
          this.origin,
          [this.#owner.port2],
        )
      }
      document.body.append(this.#bridge)
    })
    this.frame.title = 'Workspace preview'
    this.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    this.frame.setAttribute('referrerpolicy', 'no-referrer')
    await new Promise<void>((resolve, reject) => {
      let settled=false
      const finish=(error?:Error)=>{
        if(settled)return
        settled=true;clearTimeout(timer);this.#documentBoot=undefined
        error?reject(error):resolve()
      }
      const timer = setTimeout(
        () => finish(new Error('Preview document timed out')),
        this.startupTimeoutMs,
      )
      const documentURL=new URL(path,this.origin);documentURL.hash=''
      this.#documentBoot={url:documentURL.href,finish}
      this.#inspectionListener = (event: MessageEvent) => {
        if(this.#closed||event.source!==this.frame.contentWindow||event.origin!==this.origin||event.data?.type!=='sandbox-inspection-ready')return
        this.#control?.close()
        this.#rejectPending('Preview navigated')
        const channel = new MessageChannel()
        this.#control = channel.port1
        channel.port1.onmessage = (event) => {
          const message = event.data
          if (message.type === 'ready') {
            this.diagnostics.push(...message.diagnostics)
            finish()
          } else if (message.type === 'diagnostic')
            this.diagnostics.push(String(message.message))
          else if (message.type === 'result') {
            const pending = this.#pending.get(message.id)
            if (!pending) return
            clearTimeout(pending.timer)
            this.#pending.delete(message.id)
            message.error
              ? pending.reject(new Error(message.error))
              : pending.resolve(message.value)
          }
        }
        this.frame.contentWindow!.postMessage(
          { type: 'inspect-workspace' },
          this.origin,
          [channel.port2],
        )
      }
      addEventListener('message',this.#inspectionListener)
      this.navigate(path)
      container.append(this.frame)
    })
  }

  #bootNavigation(message:any,url:URL){
    const boot=this.#documentBoot,navigation=message.navigation
    if(!boot||navigation?.mode!=='navigate'||navigation.destination!=='iframe'||url.href!==boot.url)return
    const clientId=navigation.resultingClientId
    if(typeof clientId==='string'&&clientId){
      if(boot.clientId&&boot.clientId!==clientId)return
      boot.clientId=clientId
    }
    return boot
  }

  #bootResponse(boot:DocumentBoot,url:URL,response:Response):Error|undefined{
    const label=`Preview document ${url.pathname}${url.search}`
    if([301,302,303,307,308].includes(response.status)&&response.headers.has('location')){
      let target:URL
      try{target=new URL(response.headers.get('location')!,url)}
      catch{return new Error(`${label} returned HTTP ${response.status} with an invalid redirect location`)}
      target.hash=''
      if(target.origin!==this.origin||target.pathname.startsWith('/__sandbox/'))return new Error(`${label} redirected outside the workspace`)
      boot.url=target.href
      return
    }
    if(!response.ok)return new Error(`${label} returned HTTP ${response.status}`)
    const mediaType=response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()
    if([204,205].includes(response.status))return new Error(`${label} returned HTTP ${response.status} without a document`)
    if(mediaType!=='text/html'||/^attachment(?:;|$)/i.test(response.headers.get('content-disposition')??''))
      return new Error(`${label} cannot start inspection: expected an HTML document, received ${mediaType??'no content type'}`)
  }

  async #request(message: any, port: MessagePort) {
    const controller=new AbortController()
    this.#requests.add(controller)
    const timer=setTimeout(()=>controller.abort(new Error('Workspace request timed out')),this.requestTimeoutMs)
    port.onmessage=event=>{if(event.data?.type==='cancel')controller.abort(new Error('Preview request cancelled'))}
    let boot:DocumentBoot|undefined,bootError:Error|undefined
    try {
      if (this.#closed) throw new Error('Preview closed')
      const url = new URL(message.url)
      if (url.origin !== this.origin || url.pathname.startsWith('/__sandbox/'))
        throw new Error('Request outside workspace')
      boot=this.#bootNavigation(message,url)
      let response: Response
      const asset = this.#assets[url.pathname]
      if (asset && ['GET', 'HEAD'].includes(message.method))
        response = new Response(asset.slice().buffer as ArrayBuffer, {
          headers: {
            'Content-Type':
              types[url.pathname.split('.').pop()!] ??
              'application/octet-stream',
          },
        })
      else
        response = await abortableWait(this.server.fetch(
          new IncomingRequest(url, {
            method: message.method,
            headers: message.headers,
            body: message.body,
            signal:controller.signal,
          }),
        ),controller.signal)
      if(boot)bootError=this.#bootResponse(boot,url,response)
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      // Every response can become a document through navigation, including SVG.
      // The policy must not depend on the server's MIME spelling or document type.
      headers.set('Content-Security-Policy', this.policy)
      headers.delete('Content-Length')
      headers.delete('Content-Encoding')
      let body: ArrayBuffer
      const mediaType=headers.get('Content-Type')?.split(';',1)[0].trim().toLowerCase()
      if (mediaType==='text/html') {
        const html = await abortableWait(response.text(),controller.signal)
        // Preserve Start's original module URLs and hydration payload. This script only provides agent inspection.
        const script = (this.connectWebSocket?'<script src="/__sandbox/websocket.js"></script>':'')+'<script src="/__sandbox/inspect.js"></script>'
        const injected=corsExternalScripts(html,this.scriptOrigins).replace(/<head(?=[\t\n\f\r >])([^>]*)>/i, `<head$1>${script}`)
        if(boot&&!bootError&&response.ok&&injected===html)
          bootError=new Error(`Preview document ${url.pathname}${url.search} cannot start inspection: HTML without an explicit head element is not supported`)
        body = new TextEncoder().encode(injected).buffer
      } else body = await abortableWait(response.arrayBuffer(),controller.signal)
      controller.signal.throwIfAborted()
      if (body.byteLength > 16 * 1024 * 1024)
        throw new Error('Preview response too large')
      this.requests.push({
        method: message.method,
        pathname: url.pathname,
        status: response.status,
      })
      port.postMessage(
        { status: response.status, headers: [...headers], body },
        [body],
      )
      // Forward the original response before rejecting startup. HTTP success
      // alone never resolves startup, inspection must still acknowledge it.
      if(bootError)boot?.finish(bootError)
    } catch (error) {
      this.diagnostics.push(`Request ${message?.method ?? 'unknown'} ${message?.url ?? 'unknown'}: ${String(error)}`)
      port.postMessage({ error: String(error) })
      boot?.finish(bootError??new Error(`Preview document request failed: ${String(error)}`))
    } finally {
      clearTimeout(timer)
      this.#requests.delete(controller)
      port.onmessage=null
      port.close()
    }
  }

  async #openWebSocket(message:any,port:MessagePort,documentPort:MessagePort){
    if(this.#closed||documentPort!==this.#socketDocument||this.#sockets.size>=32||this.#socketPending>=32){port.postMessage({type:'error'});port.close();return}
    let socket:WorkerWebSocket|undefined,closed=false,reading=false,pullPending=false,closing=false,detached=false,detachTimer:ReturnType<typeof setTimeout>|undefined,queued=0,writes=Promise.resolve()
    const cleanup=()=>{if(closed)return;closed=true;if(detachTimer)clearTimeout(detachTimer);this.#sockets.delete(cleanup);this.#previousSockets.delete(cleanup);port.close();void socket?.dispose()}
    const fail=(error:unknown)=>{if(!closed){const message='WebSocket: '+String(error);this.diagnostics.push(message);port.postMessage({type:'error',message});cleanup()}}
    this.#sockets.add(cleanup);this.#socketPending++
    try{
      if(typeof message.url!=='string'||!Array.isArray(message.protocols)||message.protocols.some((value:unknown)=>typeof value!=='string'))throw new Error('Invalid WebSocket request')
      const url=new URL(message.url),origin=new URL(this.origin)
      const previewAddress=url.host===origin.host&&url.protocol===(origin.protocol==='https:'?'wss:':'ws:')
      const guestLoopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.protocol==='ws:'
      if((!previewAddress&&!guestLoopback)||url.username||url.password||url.hash||url.pathname.startsWith('/__sandbox/'))throw new Error('WebSocket outside workspace')
      socket=await this.connectWebSocket!(url.href,message.protocols)
      if(closed||documentPort!==this.#socketDocument){await socket.dispose();return}
      const active=socket
      let continueSuperseded=false
      const pull=()=>{
        if(reading){pullPending=true;return}
        reading=true
        void active.next().then(event=>{
          if(closed)return
          if(detached||documentPort!==this.#socketDocument){
            if(event?.type==='text'&&this.#reloadMessage(event.data))this.#retainReload(event.data)
            if(event?.type==='text'||event?.type==='binary')continueSuperseded=true
            else cleanup()
            return
          }
          if(event?.type==='text')port.postMessage({type:'message',data:event.data})
          else if(event?.type==='binary'){const data=event.data.slice().buffer;port.postMessage({type:'message',data},[data])}
          else if(event?.type==='close'){port.postMessage({type:'close',code:event.code,reason:event.reason,clean:true});cleanup()}
          else{port.postMessage({type:'close',code:1006,reason:'',clean:false});cleanup()}
        }).catch(fail).finally(()=>{
          reading=false
          if(continueSuperseded&&!closed){continueSuperseded=false;pullPending=false;pull()}
          else if(pullPending&&!closed){pullPending=false;pull()}
        })
      }
      port.onmessage=event=>{
        const command=event.data
        try{
          if(closed)return
          if(command?.type==='dispose'){cleanup();return}
          if(command?.type==='detach'){
            detached=true
            // A navigation can leave before its replacement document has
            // announced itself. Keep the server side alive briefly so Vite's
            // reload publication cannot fall into that handoff gap.
            detachTimer=setTimeout(cleanup,10_000)
            return
          }
          if(command?.type==='pull'){
            pull()
          }else if(command?.type==='send'){
            if(closing)throw new Error('WebSocket is closing')
            const data=command.data
            if(typeof data!=='string'&&!(data instanceof ArrayBuffer))throw new Error('Invalid WebSocket message')
            const bytes=typeof data==='string'?new TextEncoder().encode(data).length:data.byteLength
            if(bytes>1024*1024||queued+bytes>2*1024*1024)throw new Error('WebSocket message limit exceeded')
            queued+=bytes
            writes=writes.then(()=>active.send(typeof data==='string'?data:new Uint8Array(data))).then(()=>{queued-=bytes;if(!closed)port.postMessage({type:'sent',bytes})}).catch(fail)
          }else if(command?.type==='close'){
            if(closing)return
            if(typeof command.code!=='number'||typeof command.reason!=='string')throw new Error('Invalid WebSocket close')
            closing=true;writes=writes.then(()=>active.close(command.code,command.reason)).catch(fail)
          }else throw new Error('Unknown WebSocket command')
        }catch(error){fail(error)}
      }
      port.postMessage({type:'open',protocol:socket.protocol})
      for(const data of this.#reloadHandoff)port.postMessage({type:'message',data})
      this.#reloadHandoff=[]
      for(const close of this.#previousSockets)close()
      this.#previousSockets.clear()
    }catch(error){fail(error)}finally{this.#socketPending--}
  }

  #reloadMessage(data:string){
    if(data.length>64*1024)return false
    try{return JSON.parse(data)?.type==='full-reload'}catch{return false}
  }

  #retainReload(data:string){
    this.#reloadHandoff.push(data)
    if(this.#reloadHandoff.length>8)this.#reloadHandoff.shift()
  }

  #call(
    type: string,
    selector?: string,
  ): Promise<PreviewState & { url: string }> {
    if (this.#closed || !this.#control)
      return Promise.reject(new Error('Preview closed or not ready'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Preview action timed out'))
      }, 5000)
      this.#pending.set(id, { resolve, reject, timer })
      this.#control!.postMessage({ type, selector, id })
    })
  }
  inspect() {
    return this.#call('inspect')
  }
  click(selector: string) {
    return this.#call('click', selector)
  }
  navigate(path: string) {
    if (this.#closed) throw new Error('Preview closed')
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin || url.pathname.startsWith('/__sandbox/'))
      throw new Error('Navigation outside workspace')
    this.frame.src = url.href
  }
  #rejectPending(message: string) {
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error(message))
    }
    this.#pending.clear()
  }
  close() {
    if (this.#closed) return
    this.#closed = true
    // Destroy the app document before taking away its transports. A live HMR
    // client treats lost requests or sockets as a reason to reconnect.
    this.frame.remove()
    this.#documentBoot?.finish(new Error('Preview closed'))
    for(const request of this.#requests)request.abort(new Error('Preview closed'))
    this.#requests.clear()
    removeEventListener('message',this.#socketListener)
    if(this.#inspectionListener)removeEventListener('message',this.#inspectionListener)
    this.#socketDocument?.close()
    for(const close of this.#sockets)close()
    for(const close of this.#previousSockets)close()
    this.#reloadHandoff=[]
    this.#rejectPending('Preview closed')
    this.#control?.close()
    this.#owner.port1.close()
    this.#bridge.remove()
    leasedOrigins.delete(this.origin)
  }
}
