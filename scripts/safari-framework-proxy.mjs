// Test-only host for native Safari UI checks. Runtime bytes are unchanged unless
// the explicit diagnostic-only install trace is enabled.
import {createServer} from 'node:http'
import {pathToFileURL} from 'node:url'
import {safariInstallStageTraceSource} from './safari-install-stage-trace.mjs'

export const safariCapacityInstrumentation = `
(() => {
  const NativeWorker = globalThis.Worker
  let nextWorker = 0
  const workers = new Map()
  const events = []
  const record = (type, worker, detail = {}) => {
    events.push({sequence: events.length + 1, type, worker, ...detail})
    if (events.length > 256) events.shift()
  }
  const release = (worker, reason) => {
    const state = workers.get(worker)
    if (!state || state.released) return
    state.released = true
    state.releaseReason = reason
    record('worker.release', worker, {reason})
  }
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(Target, args) {
      const instance = Reflect.construct(Target, args)
      const worker = ++nextWorker
      const state = {url: String(args[0]), released: false, messages: {received: 0, heartbeats: 0, progress: 0, replies: 0}, requests: [], installStages: [], installStagesDropped: 0, installPhases: [], installPhasesDropped: 0, installTraceLimits: {}}
      workers.set(worker, state)
      instance.addEventListener('message', event => {
        const message = event.data
        state.messages.received++
        if (message?.type === 'sandbox-install-stage') {
          const row={traceId:message.traceId,stage:message.stage,state:message.state,at:message.at}
          const phase=message.channel==='phase'
          const channel=phase?'phase':'io'
          if(message.stage==='trace'&&message.state==='limit')state.installTraceLimits[channel]=row
          if(phase){
            state.installPhases.push(row)
            if(state.installPhases.length>2049){state.installPhases.shift();state.installPhasesDropped++}
          }else{
            state.installStages.push(row)
            if(state.installStages.length>128){state.installStages.shift();state.installStagesDropped++}
          }
        }
        if (message?.type === 'heartbeat') state.messages.heartbeats++
        if (message?.type === 'progress') state.messages.progress++
        if (Number.isInteger(message?.id) && (Object.hasOwn(message, 'value') || Object.hasOwn(message, 'error'))) {
          state.messages.replies++
          const request = state.requests.find(row => row.id === message.id)
          if (request) request.status = Object.hasOwn(message, 'error') ? 'error' : 'replied'
        }
      })
      record('worker.create', worker, {url: String(args[0])})
      const terminate = instance.terminate.bind(instance)
      const postMessage = instance.postMessage.bind(instance)
      const trackedPostMessage = (...messageArgs) => {
        const message = messageArgs[0]
        if (Number.isInteger(message?.id) && typeof message.method === 'string') {
          state.requests.push({id: message.id, method: message.method, status: 'pending'})
          if (state.requests.length > 32) state.requests.shift()
        }
        if (message?.method === 'shutdown' && Number.isInteger(message.id)) {
          const id = message.id
          record('worker.shutdown-request', worker, {id})
          const acknowledge = event => {
            if (event.data?.id !== id || (!Object.hasOwn(event.data, 'value') && !Object.hasOwn(event.data, 'error'))) return
            instance.removeEventListener('message', acknowledge)
            release(worker, 'shutdown-acknowledged')
          }
          instance.addEventListener('message', acknowledge)
        }
        return postMessage(...messageArgs)
      }
      instance.addEventListener('error', event => record('worker.error', worker, {message: event.message || 'Worker error'}))
      return new Proxy(instance, {
        get(target, property) {
          if (property === 'terminate') return () => { release(worker, 'terminate'); return terminate() }
          if (property === 'postMessage') return trackedPostMessage
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
        set(target, property, value) { return Reflect.set(target, property, value, target) },
      })
    },
  })
  globalThis.__safariWorkerCapacity = {
    snapshot() {
      const rows = [...workers.entries()].map(([worker, state]) => ({worker, ...state}))
      return {created: rows.length, released: rows.filter(row => row.released).length, active: rows.filter(row => !row.released).length, workers: rows, events: events.slice()}
    },
  }
})()
`

// Diagnostic-only observation of header settlement, never response-body completion.
export function installSafariWorkerHTTPTrace(WorkerHTTP){
  const original=WorkerHTTP.prototype.fetch,events=[]
  let next=0,total=0
  const record=(id,category,state,status)=>{
    total++
    events.push({id,category,state,...(typeof status==='number'?{status}:{}),at:performance.now()})
    if(events.length>64)events.shift()
  }
  WorkerHTTP.prototype.fetch=function(...args){
    const id=++next
    let category='other'
    try{if(new URL(args[0].url).pathname==='/')category='root'}catch{}
    record(id,category,'begin')
    try{
      const result=Reflect.apply(original,this,args)
      void result.then(response=>record(id,category,'headers',response.status),()=>record(id,category,'error'))
      return result
    }catch(error){record(id,category,'error');throw error}
  }
  globalThis.__safariWorkerHTTPTrace={snapshot:()=>({events:events.slice(),total,dropped:total-events.length,scope:'headers-only'})}
}

export const safariCapacityBridge = `
let safariCleanup = {status: 'idle'}
let safariCapacitySampling = false
const safariCapacitySampler = setInterval(async() => {
  if (!session || safariCapacitySampling || document.querySelector('#open')?.disabled) return
  safariCapacitySampling = true
  try {
    const resources = await session.kernel.resources()
    const interrupts = (session.kernel.jobProfile ?? []).filter(row => row.phase === 'interrupt')
    const snapshot = globalThis.__safariWorkerCapacity.snapshot()
    const workers = {
      created:snapshot.created,active:snapshot.active,released:snapshot.released,
      total:snapshot.workers.length,omitted:Math.max(0,snapshot.workers.length-4),
      workers:snapshot.workers.slice(-4).map(row=>({
        worker:row.worker,released:row.released,releaseReason:row.releaseReason,messages:row.messages,
        installStages:row.installStages.slice(-16),
        installStagesTotal:row.installStages.length+row.installStagesDropped,
        installStagesDropped:row.installStagesDropped,
        installStagesOmitted:Math.max(0,row.installStages.length-16),
        installPhases:row.installPhases.slice(-32),
        installPhasesTotal:row.installPhases.length+row.installPhasesDropped,
        installPhasesDropped:row.installPhasesDropped,
        installPhasesOmitted:Math.max(0,row.installPhases.length-32),
        installTraceLimits:row.installTraceLimits,
      })),
    }
    const owner={visibility:document.visibilityState,readyState:document.readyState,iframeCount:document.querySelectorAll('iframe').length}
    const previewHTTP=globalThis.__safariWorkerHTTPTrace?.snapshot()
    const previewLiveness=globalThis.__safariPreviewLiveness?.snapshot()
    await fetch('/__test/capacity-sample',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({at:performance.now(),resources,interrupts,workers,owner,...(previewHTTP?{previewHTTP}:{}),...(previewLiveness?{previewLiveness}:{})})})
  } catch {} finally { safariCapacitySampling = false }
}, 1000)
addEventListener('pagehide',()=>clearInterval(safariCapacitySampler),{once:true})
globalThis.__safariAcceptanceCapacity = {
  async snapshot() {
    return {
      workers: globalThis.__safariWorkerCapacity.snapshot(),
      kernel: session ? await session.kernel.resources() : null,
      workerLifecycle: session ? session.kernel.workerLifecycle.slice() : [],
      workerStartFailures: session ? session.kernel.workerStartFailures.slice() : [],
      interrupts: session ? (session.kernel.jobProfile ?? []).filter(row => row.phase === 'interrupt') : [],
      cleanup: {...safariCleanup},
    }
  },
  close() {
    const current = session
    session = undefined
    if (!current) { safariCleanup = {status: 'passed'}; return }
    safariCleanup = {status: 'pending'}
    current.close()
    Promise.resolve(current.kernel.shutdown).then(
      () => { safariCleanup = {status: 'passed'} },
      error => { safariCleanup = {status: 'failed', error: String(error)} },
    )
  },
  cleanup() { return {...safariCleanup} },
}
`

export async function startSafariFrameworkProxy(targetURL,{instrumentCapacity=true,traceInstall=false}={}) {
  if(traceInstall&&!instrumentCapacity)throw Error('Install tracing requires capacity observation')
  const target = new URL(targetURL)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw Error('Expected a local example server')
  const configResponse = await fetch(new URL('/config.json', target))
  if (!configResponse.ok) throw Error('Example configuration unavailable')
  const {previewOrigin} = await configResponse.json()
  const preview = new URL(previewOrigin)
  if (preview.protocol !== 'http:' || preview.hostname !== '127.0.0.1') throw Error('Expected a local preview server')
  let offline = false
  const capacitySamples = []
  const requestEvents=[]
  let requestSequence=0,requestEventTotal=0
  const recordRequest=(id,category,stage,detail={})=>{
    requestEventTotal++
    requestEvents.push({id,category,stage,at:Date.now(),...detail})
    if(requestEvents.length>256)requestEvents.shift()
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost')
    const requestId=++requestSequence
    const category=path.pathname==='/'?'document':path.pathname==='/client.js'?'client-module':path.pathname==='/config.json'?'configuration':path.pathname==='/projects.json'?'projects':path.pathname.startsWith('/runtime/')?'sdk-module':'other'
    const observe=path.pathname!=='/__test/capacity-sample'
    const record=(stage,detail)=>{if(observe)recordRequest(requestId,category,stage,detail)}
    record('receive')
    response.once('finish',()=>record('downstream-finish',{status:response.statusCode}))
    response.once('close',()=>{if(!response.writableFinished)record('premature-close')})
    response.once('error',()=>record('error'))
    if (path.pathname === '/__test/network') {
      if (request.method === 'POST') {
        const mode = path.searchParams.get('mode')
        if (!['offline', 'online'].includes(mode)) {response.writeHead(400);response.end();return}
        offline = mode === 'offline'
      } else if (request.method !== 'GET') {response.writeHead(405);response.end();return}
      response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'})
      response.end(JSON.stringify({offline, previewOrigin: preview.origin}))
      return
    }
    if (instrumentCapacity && path.pathname === '/__test/capacity-sample') {
      if (request.method !== 'POST') {response.writeHead(405);response.end();return}
      const chunks=[];let bytes=0
      for await (const chunk of request){bytes+=chunk.length;if(bytes>256*1024){response.writeHead(413);response.end();return}chunks.push(chunk)}
      try{capacitySamples.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(capacitySamples.length>256)capacitySamples.shift()}
      catch{response.writeHead(400);response.end();return}
      response.writeHead(204);response.end();return
    }
    if (instrumentCapacity && path.pathname === '/__test/capacity.js') {
      response.writeHead(200, {'Content-Type':'text/javascript','Cache-Control':'no-store'})
      response.end(safariCapacityInstrumentation)
      return
    }
    if (request.method !== 'GET') {response.writeHead(405);response.end();return}
    try {
      const upstreamURL = new URL(target)
      upstreamURL.pathname = path.pathname
      upstreamURL.search = path.search
      const upstream = await fetch(upstreamURL, {redirect:'error'})
      record('upstream-headers',{status:upstream.status})
      const headers = {'Content-Type':upstream.headers.get('content-type') ?? 'application/octet-stream','Cache-Control':'no-store'}
      // The packaged fiber engine requires an isolated owner. Preserve the
      // isolation headers emitted by the exact packaged example rather than
      // silently turning the Safari acceptance host into a different profile.
      for (const name of ['cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy','x-content-type-options']) {
        const value = upstream.headers.get(name)
        if (value) headers[name] = value
      }
      // Workers inherit this restriction too. Keep it enabled until all resumed
      // processes are stopped. Only the owner and local preview may connect.
      if (offline) headers['Content-Security-Policy'] = `connect-src 'self' ${preview.origin}`
      let bytes = Buffer.from(await upstream.arrayBuffer())
      record('upstream-body',{bytes:bytes.length})
      if (traceInstall && path.pathname === '/runtime/workers/kernel.js' && upstream.ok) {
        bytes = Buffer.concat([Buffer.from(safariInstallStageTraceSource),bytes])
      }
      const contentType = upstream.headers.get('content-type') ?? ''
      if (instrumentCapacity && path.pathname === '/' && upstream.ok && /\btext\/html\b/i.test(contentType)) {
        const html = bytes.toString('utf8')
        if (!html.includes('<script type="module" src="/client.js"></script>')) throw Error('Safari capacity instrumentation could not find the framework client entry')
        bytes = Buffer.from(html.replace('<script type="module" src="/client.js"></script>','<script src="/__test/capacity.js"></script><script type="module" src="/client.js"></script>'))
      } else if (instrumentCapacity && path.pathname === '/client.js' && upstream.ok && /\b(?:text|application)\/javascript\b/i.test(contentType)) {
        bytes = Buffer.from(bytes.toString('utf8') + '\n;\n' + (traceInstall?'('+installSafariWorkerHTTPTrace.toString()+')(WorkerHTTP);\n':'') + safariCapacityBridge)
      }
      response.writeHead(upstream.status, headers)
      response.end(bytes)
    } catch (error) {
      record('error')
      response.writeHead(502, {'Content-Type':'text/plain'})
      response.end(String(error))
    }
  })
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {origin:`http://127.0.0.1:${server.address().port}`,capacitySamples,requestLedgerSnapshot:()=>({events:requestEvents.map(row=>({...row})),total:requestEventTotal,dropped:requestEventTotal-requestEvents.length}),close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = await startSafariFrameworkProxy(process.argv[2])
  console.log(proxy.origin)
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>void proxy.close().then(()=>process.exit(0)))
}
