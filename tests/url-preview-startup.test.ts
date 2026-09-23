import {afterEach,describe,it,expect,vi} from 'vitest'
import {URLPreview} from '../src/sandbox/url-preview'

const origin='https://preview.invalid'
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.unstubAllGlobals()})

async function fixture(fetch:(request:Request)=>Promise<Response>,path='/',connectWebSocket?:Parameters<typeof URLPreview.mount>[1]['connectWebSocket'],timeouts:Pick<Parameters<typeof URLPreview.mount>[1],'requestTimeoutMs'|'startupTimeoutMs'|'scriptOrigins'|'connectOrigins'>={}){
  const bus=new EventTarget(),frames:any[]=[],ports:MessagePort[]=[]
  let ownerPort:MessagePort|undefined,preview:URLPreview|undefined,appended=false
  const emit=(source:any,eventOrigin=origin)=>{
    bus.dispatchEvent(Object.assign(new Event('message'),{source,origin:eventOrigin,data:{type:'sandbox-inspection-ready'},ports:[]}))
  }
  vi.stubGlobal('location',new URL('https://owner.invalid/'))
  vi.stubGlobal('addEventListener',bus.addEventListener.bind(bus))
  vi.stubGlobal('removeEventListener',bus.removeEventListener.bind(bus))
  vi.stubGlobal('document',{
    createElement(){
      const element:any={src:'',attributes:{},setAttribute(name:string,value:string){this.attributes[name]=value},remove:vi.fn(),
        contentWindow:{postMessage(data:any,_origin:string,transfer:MessagePort[]){
          ports.push(...transfer)
          if(data.type==='attach-workspace'){ownerPort=transfer[0];ownerPort.postMessage({type:'ready'})}
          if(data.type==='inspect-workspace')transfer[0].postMessage({type:'ready',diagnostics:[]})
        }},
      }
      frames.push(element);return element
    },
    body:{append(element:any){queueMicrotask(()=>element.onload?.())}},
  })
  const result=URLPreview.mount({append(){appended=true}} as unknown as HTMLElement,{origin,server:{fetch},path,connectWebSocket,...timeouts})
  void result.then(value=>preview=value,()=>{})
  cleanups.push(()=>{preview?.close();for(const port of ports)port.close()})
  await vi.waitFor(()=>expect(appended).toBe(true))
  return {result,frames,
    socket(){
      const channel=new MessageChannel();ports.push(channel.port1,channel.port2)
      bus.dispatchEvent(Object.assign(new Event('message'),{source:frames[0].contentWindow,origin,data:{type:'sandbox-websocket-document'},ports:[channel.port2]}))
      const connection=new MessageChannel();ports.push(connection.port1,connection.port2)
      channel.port1.postMessage({type:'connect',url:'wss://preview.invalid/',protocols:[]},[connection.port2])
      return connection.port1
    },
    async request(path='/',navigation:any={mode:'navigate',destination:'iframe',resultingClientId:'document-1'}){
      const channel=new MessageChannel();ports.push(channel.port1,channel.port2)
      const response=new Promise<any>(resolve=>{channel.port1.onmessage=event=>{channel.port1.close();resolve(event.data)}})
      ownerPort!.postMessage({type:'request',url:origin+path,method:'GET',headers:[],navigation},[channel.port2])
      return response
    },
    announce(source=frames[0].contentWindow,eventOrigin=origin){emit(source,eventOrigin)},
  }
}
const html=()=>new Response('<html><head></head><body>App</body></html>',{headers:{'content-type':'text/html'}})

describe('preview teardown',()=>{
  it('removes the app before aborting requests or disposing sockets, and closes only once',async()=>{
    const order:string[]=[]
    let requestStarted=false
    const dispose=vi.fn(async()=>{order.push('socket')})
    const f=await fixture(async request=>{
      if(new URL(request.url).pathname!=='/pending')return html()
      requestStarted=true
      return new Promise<Response>((_resolve,reject)=>request.signal.addEventListener('abort',()=>{
        order.push('request');reject(request.signal.reason)
      },{once:true}))
    },'/',async()=>({protocol:'',dispose}) as any)
    f.announce();const preview=await f.result
    const socket=f.socket()
    await new Promise<void>(resolve=>{socket.onmessage=event=>{if(event.data.type==='open')resolve()}})
    f.frames[0].remove.mockImplementation(()=>order.push('frame'))
    f.frames[1].remove.mockImplementation(()=>order.push('bridge'))
    const response=f.request('/pending',null)
    await vi.waitFor(()=>expect(requestStarted).toBe(true))
    const inspection=expect(preview.inspect()).rejects.toThrow('Preview closed')
    preview.close();preview.close()
    await inspection
    expect((await response).error).toContain('Preview closed')
    expect(order).toEqual(['frame','request','socket','bridge'])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(f.frames[0].remove).toHaveBeenCalledTimes(1)
    expect(f.frames[1].remove).toHaveBeenCalledTimes(1)
    await expect(preview.inspect()).rejects.toThrow('Preview closed')
    expect(()=>preview.navigate('/')).toThrow('Preview closed')
    // Cleanup also releases the origin lease so a replacement can mount.
    const next=await fixture(async()=>html());next.announce();await next.result
  })

  it('disposes a connection that finishes opening after the document was removed',async()=>{
    let accept:((socket:any)=>void)|undefined
    const dispose=vi.fn(async()=>{})
    const f=await fixture(async()=>html(),'/',()=>new Promise(resolve=>{accept=resolve}))
    f.announce();const preview=await f.result
    f.socket()
    await vi.waitFor(()=>expect(accept).toBeTypeOf('function'))
    preview.close()
    expect(f.frames[0].remove).toHaveBeenCalledTimes(1)
    accept!({protocol:'',dispose})
    await vi.waitFor(()=>expect(dispose).toHaveBeenCalledTimes(1))
    preview.close()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('preview request deadlines',()=>{
  it('rejects request and startup deadlines outside the public bounded range',async()=>{
    vi.stubGlobal('location',new URL('https://owner.invalid/'))
    const container={} as HTMLElement,server={fetch:async()=>html()}
    for(const value of [NaN,0,10.5,120001]){
      await expect(URLPreview.mount(container,{origin,server,requestTimeoutMs:value})).rejects.toThrow('requestTimeoutMs')
      await expect(URLPreview.mount(container,{origin,server,startupTimeoutMs:value})).rejects.toThrow('startupTimeoutMs')
    }
  })

  it('aborts one slow workspace request at its configured deadline',async()=>{
    let aborted:unknown
    const f=await fixture(async request=>{
      if(new URL(request.url).pathname!=='/pending')return html()
      return new Promise<Response>((_resolve,reject)=>request.signal.addEventListener('abort',()=>{
        aborted=request.signal.reason;reject(request.signal.reason)
      },{once:true}))
    },'/',undefined,{requestTimeoutMs:20})
    f.announce();await f.result
    const response=await f.request('/pending',null)
    expect(response.error).toContain('Workspace request timed out')
    expect(String(aborted)).toContain('Workspace request timed out')
  })
})

describe('preview external script policy',()=>{
  it('allows only explicitly declared exact HTTPS origins',async()=>{
    const f=await fixture(async()=>new Response('<html><head><script src="https://unpkg.com/tool.js"></script></head><body>App</body></html>',{headers:{'content-type':'text/html'}}),'/',undefined,{scriptOrigins:['https://unpkg.com']})
    const response=await f.request()
    const policy=new Headers(response.headers).get('content-security-policy')
    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://unpkg.com")
    expect(new TextDecoder().decode(response.body)).toContain('src="https://unpkg.com/tool.js" crossorigin="anonymous"')
    f.announce();await f.result
  })

  it.each(['http://unpkg.com','https://unpkg.com/path','not a url'])('rejects unsafe or inexact script origin %s',async scriptOrigin=>{
    vi.stubGlobal('location',new URL('https://owner.invalid/'))
    await expect(URLPreview.mount({} as HTMLElement,{origin,server:{fetch:async()=>html()},scriptOrigins:[scriptOrigin]})).rejects.toThrow('script origin')
  })
})

describe('preview external connection policy',()=>{
  it('allows only explicitly declared exact HTTPS origins',async()=>{
    const f=await fixture(async()=>html(),'/',undefined,{connectOrigins:['https://jsonplaceholder.typicode.com']})
    const response=await f.request()
    const policy=new Headers(response.headers).get('content-security-policy')
    expect(policy).toContain("connect-src 'self' https://jsonplaceholder.typicode.com")
    f.announce();await f.result
  })

  it.each(['http://jsonplaceholder.typicode.com','https://jsonplaceholder.typicode.com/posts','not a url'])('rejects unsafe or inexact connection origin %s',async connectOrigin=>{
    vi.stubGlobal('location',new URL('https://owner.invalid/'))
    await expect(URLPreview.mount({} as HTMLElement,{origin,server:{fetch:async()=>html()},connectOrigins:[connectOrigin]})).rejects.toThrow('connect origin')
  })
})

describe('preview websocket navigation handoff',()=>{
  it('coalesces duplicate read requests without failing the socket',async()=>{
    let deliver!:(event:any)=>void
    const next=vi.fn(()=>new Promise(resolve=>{deliver=resolve}))
    const dispose=vi.fn(async()=>{})
    const f=await fixture(async()=>html(),'/',async()=>({protocol:'vite-hmr',next,send:vi.fn(),close:vi.fn(),dispose}) as any)
    f.announce();const preview=await f.result
    const socket=f.socket(),messages:any[]=[]
    socket.onmessage=event=>messages.push(event.data)
    await vi.waitFor(()=>expect(messages[0]).toEqual({type:'open',protocol:'vite-hmr'}))
    socket.postMessage({type:'pull'});socket.postMessage({type:'pull'})
    await vi.waitFor(()=>expect(next).toHaveBeenCalledTimes(1))
    deliver({type:'text',data:'ready'})
    await vi.waitFor(()=>expect(messages).toContainEqual({type:'message',data:'ready'}))
    await vi.waitFor(()=>expect(next).toHaveBeenCalledTimes(2))
    expect(messages.some(message=>message.type==='error')).toBe(false)
    preview.close()
  })

  it('replays only bounded Vite full reload publication after the replacement socket opens',async()=>{
    const peers:{next:ReturnType<typeof vi.fn>;dispose:ReturnType<typeof vi.fn>;deliver(event:any):void}[]=[]
    let acceptReplacement:((peer:any)=>void)|undefined
    const connect=vi.fn(async()=>{
      let deliver!:(event:any)=>void
      const next=vi.fn(()=>new Promise(resolve=>{deliver=resolve}))
      const peer={protocol:'vite-hmr',next,send:vi.fn(),close:vi.fn(),dispose:vi.fn(async()=>{}),deliver(event:any){deliver(event)}}
      peers.push(peer)
      if(peers.length===1)return peer as any
      return new Promise(resolve=>{acceptReplacement=()=>resolve(peer as any)})
    })
    const f=await fixture(async()=>html(),'/',connect)
    f.announce();const preview=await f.result
    const first=f.socket(),firstMessages:any[]=[]
    first.onmessage=event=>firstMessages.push(event.data)
    await vi.waitFor(()=>expect(firstMessages[0]).toEqual({type:'open',protocol:'vite-hmr'}))
    first.postMessage({type:'pull'})
    await vi.waitFor(()=>expect(peers[0].next).toHaveBeenCalledTimes(1))

    // pagehide can run before the replacement document announces itself.
    // Detaching must keep the server socket draining during that gap.
    first.postMessage({type:'detach'})
    await new Promise(resolve=>setTimeout(resolve,0))
    peers[0].deliver({type:'text',data:JSON.stringify({type:'full-reload',path:'*'})})
    await vi.waitFor(()=>expect(peers[0].next).toHaveBeenCalledTimes(2))
    peers[0].deliver({type:'text',data:JSON.stringify({type:'update',updates:[{path:'/stale.ts'}]})})

    const second=f.socket(),secondMessages:any[]=[]
    second.onmessage=event=>secondMessages.push(event.data)
    await vi.waitFor(()=>expect(acceptReplacement).toBeTypeOf('function'))
    acceptReplacement!(peers[1])
    await vi.waitFor(()=>expect(secondMessages).toContainEqual({type:'message',data:JSON.stringify({type:'full-reload',path:'*'})}))
    expect(secondMessages).not.toContainEqual({type:'message',data:JSON.stringify({type:'update',updates:[{path:'/stale.ts'}]})})
    await vi.waitFor(()=>expect(peers[0].dispose).toHaveBeenCalledTimes(1))
    preview.close()
  })
})

describe('preview initial document failures',()=>{
  for(const status of [404,500])it(`reports HTTP ${status} without an inspection handshake`,async()=>{
    const f=await fixture(async()=>new Response('server failed',{status,headers:{'content-type':'text/plain'}}))
    const rejected=expect(f.result).rejects.toThrow(`Preview document / returned HTTP ${status}`)
    const response=await f.request()
    expect(response.status).toBe(status)
    expect(new TextDecoder().decode(response.body)).toBe('server failed')
    expect(new Headers(response.headers).get('content-security-policy')).toContain("default-src 'none'")
    await rejected
  })
  it('reports a thrown document transport error',async()=>{
    const f=await fixture(async()=>{throw Error('guest socket closed')})
    const rejected=expect(f.result).rejects.toThrow('Preview document request failed: Error: guest socket closed')
    expect((await f.request()).error).toContain('guest socket closed')
    await rejected
  })
  it('reports unsupported HTML fragments without changing their body',async()=>{
    const fragment='<header>App</header><p>Valid HTML fragment</p>'
    const f=await fixture(async()=>new Response(fragment,{headers:{'content-type':'text/html'}}))
    const rejected=expect(f.result).rejects.toThrow('HTML without an explicit head element is not supported')
    expect(new TextDecoder().decode((await f.request()).body)).toBe(fragment)
    await rejected
  })
  for(const [name,response] of [
    ['JSON',()=>Response.json({value:1})],
    ['no document',()=>new Response(null,{status:204})],
    ['download',()=>new Response('<html><head></head></html>',{headers:{'content-type':'text/html','content-disposition':'attachment; filename=app.html'}})],
  ] as const)it(`reports unsupported ${name} navigation`,async()=>{
    const f=await fixture(async()=>response())
    const rejected=expect(f.result).rejects.toThrow(name==='no document'?'without a document':'cannot start inspection')
    await f.request();await rejected
  })
  for(const [name,navigation,path] of [
    ['ordinary fetch',{mode:'cors',destination:'',resultingClientId:''},'/'],
    ['script',{mode:'cors',destination:'script',resultingClientId:''},'/'],
    ['other document URL',{mode:'navigate',destination:'iframe',resultingClientId:'other'},'/other'],
    ['missing metadata',undefined,'/'],
  ] as const)it(`does not fail startup for an HTTP error on ${name}`,async()=>{
    const f=await fixture(async()=>new Response('not found',{status:404}))
    // Explicit null avoids the fixture's default navigation metadata.
    expect((await f.request(path,navigation??null)).status).toBe(404)
    f.announce();await f.result
  })
  it('waits for the validated inspection handshake after successful HTML',async()=>{
    const f=await fixture(async()=>html())
    const settled=vi.fn();void f.result.then(settled,settled)
    const response=await f.request()
    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(response.body)).toContain('/__sandbox/inspect.js')
    f.announce({},origin);f.announce(f.frames[0].contentWindow,'https://foreign.invalid')
    await new Promise(resolve=>setTimeout(resolve,10))
    expect(settled).not.toHaveBeenCalled()
    f.announce();await f.result
    expect(f.frames[0].attributes.sandbox).toBe('allow-scripts allow-same-origin')
  })
  it('follows same-origin redirect identity and reports its final HTTP error',async()=>{
    const f=await fixture(async request=>new URL(request.url).pathname==='/'?new Response(null,{status:302,headers:{location:'/login?next=app#form'}}):new Response('failed',{status:500}))
    const rejected=expect(f.result).rejects.toThrow('Preview document /login?next=app returned HTTP 500')
    expect((await f.request()).status).toBe(302)
    expect((await f.request('/login?next=app')).status).toBe(500)
    await rejected
  })
  it('does not mistake another client for the redirect target',async()=>{
    const f=await fixture(async request=>new URL(request.url).pathname==='/'?new Response(null,{status:307,headers:{location:'/next'}}):new Response('other client error',{status:500}))
    await f.request()
    await f.request('/next',{mode:'navigate',destination:'iframe',resultingClientId:'other-client'})
    f.announce();await f.result
  })
  it('permits a successful redirect but still requires inspection',async()=>{
    const f=await fixture(async request=>new URL(request.url).pathname==='/'?new Response(null,{status:303,headers:{location:'/next'}}):html())
    expect((await f.request()).status).toBe(303)
    expect((await f.request('/next')).status).toBe(200)
    f.announce();await f.result
  })
  it('reports a redirect outside the workspace without rewriting it',async()=>{
    const f=await fixture(async()=>new Response(null,{status:302,headers:{location:'https://foreign.invalid/'}}))
    const rejected=expect(f.result).rejects.toThrow('redirected outside the workspace')
    const response=await f.request()
    expect(response.status).toBe(302)
    expect(new Headers(response.headers).get('location')).toBe('https://foreign.invalid/')
    await rejected
  })
  it('reports a malformed redirect without rewriting its status, location or body',async()=>{
    const f=await fixture(async()=>new Response('redirect response',{status:302,headers:{location:'http://[','content-type':'text/plain'}}))
    const rejected=expect(f.result).rejects.toThrow('Preview document / returned HTTP 302 with an invalid redirect location')
    const response=await f.request()
    expect(response.status).toBe(302)
    expect(new Headers(response.headers).get('location')).toBe('http://[')
    expect(new TextDecoder().decode(response.body)).toBe('redirect response')
    expect(response.error).toBeUndefined()
    await rejected
  })
  it('does not reject or close an already mounted preview for later navigation errors',async()=>{
    let fail=false
    const f=await fixture(async()=>fail?new Response('failed',{status:500}):html())
    await f.request();f.announce()
    const preview=await f.result
    fail=true
    expect((await f.request()).status).toBe(500)
    expect(()=>preview.navigate('/next')).not.toThrow()
  })
})
