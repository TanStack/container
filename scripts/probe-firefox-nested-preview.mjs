import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { chromium, firefox, webkit } from '@playwright/test'

const siblingBridge = process.env.PROBE_SIBLING_BRIDGE === '1'
const messageBridge = process.env.PROBE_MESSAGE_BRIDGE === '1'
const inspectHandshake = process.env.PROBE_INSPECT_HANDSHAKE === '1'
const binaryBody = process.env.PROBE_BINARY_BODY === '1'
const realServiceWorker = process.env.PROBE_REAL_SW === '1'
const reservedOuter = process.env.PROBE_OUTER_RESERVED === '1'
const externalOuter = process.env.PROBE_EXTERNAL_OUTER === '1'
const ownerFrame = process.env.PROBE_OWNER_FRAME === '1'
const preexistingInner = process.env.PROBE_PREEXISTING_INNER === '1'
const parentBridge = process.env.PROBE_PARENT_BRIDGE === '1'
const realBridge = process.env.PROBE_REAL_BRIDGE === '1'
const outerLayout = process.env.PROBE_OUTER_LAYOUT === '1'
const parentHost = process.env.PROBE_PARENT_HOST ?? '127.0.0.1'
if (realBridge && !realServiceWorker) throw Error('Real bridge requires real service worker')
const delayMs = Number(process.env.PROBE_SW_DELAY_MS ?? 0)
if (messageBridge && !siblingBridge) throw Error('Message bridge requires sibling bridge')
const targetHTML = `<!doctype html><head>${inspectHandshake ? '<script src="/inspect.js"></script>' : ''}</head><body><button onclick="top.postMessage({clicked:true},String.fromCharCode(42))">click me</button></body>`
const inlineTargetHTML = JSON.stringify(targetHTML).replaceAll('</script>', '<\\/script>')
const targetHeaders = {
  'Content-Type':'text/html',
  'Cross-Origin-Resource-Policy':'cross-origin',
  'Cross-Origin-Embedder-Policy':'require-corp',
  'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
}
const sourceResponse = messageBridge
  ? `(async()=>{
      const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true})
      const bridge=clients.find(client=>new URL(client.url).pathname==='/bridge')
      if(!bridge)throw Error('Bridge missing')
      const result=await new Promise(resolve=>{
        const channel=new MessageChannel()
        channel.port1.onmessage=event=>resolve(event.data)
        bridge.postMessage({type:'request'},[channel.port2])
      })
      return new Response(result.body,{headers:${JSON.stringify(targetHeaders)}})
    })()`
  : `Promise.resolve(new Response(${JSON.stringify(targetHTML)},{headers:${JSON.stringify(targetHeaders)}}))`
const outerScript = `
  ${inspectHandshake ? `addEventListener('message', event => {
    if(event.data?.type==='sandbox-inspection-ready'&&event.source===document.querySelector('iframe')?.contentWindow){
      const channel=new MessageChannel()
      event.source.postMessage({type:'inspect-workspace'},location.origin,[channel.port2])
    }
  })` : ''}
  async function start() {
    ${siblingBridge ? '' : "await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready"}
    const frame = ${preexistingInner ? "document.querySelector('iframe[title=inner]')" : "document.createElement('iframe')"}
    frame.setAttribute('sandbox','allow-scripts allow-same-origin')
    frame.src = '/target'
    frame.width = '240'
    frame.height = '100'
    frame.onload = () => top.postMessage({ready:true}, '*')
    ${preexistingInner ? '' : 'document.body.append(frame)'}
  }
  ${siblingBridge ? "addEventListener('message', event => { if (event.source === parent && event.data?.start) void start() })" : 'void start()'}
`
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/sw.js' || request.url?.endsWith('.js') ? 'text/javascript' : 'text/html')
  if (process.env.PROBE_COOP === '1' || (process.env.PROBE_COOP === 'parent' && request.headers.host?.startsWith(`${parentHost}:`)) || (process.env.PROBE_COOP === 'preview' && request.headers.host?.startsWith('isolated.localhost:')) || (process.env.PROBE_COOP === 'owner' && request.headers.host?.startsWith('localhost:')))
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  if (request.url === '/__sandbox/sw.js') {
    response.setHeader('Service-Worker-Allowed','/')
    response.end(readFileSync(new URL('../preview-host/sw.js',import.meta.url)))
    return
  }
  if (realBridge && request.url === '/__sandbox/bridge.html') {
    response.end(readFileSync(new URL('../preview-host/bridge.html',import.meta.url)))
    return
  }
  if (realBridge && request.url === '/__sandbox/bridge.js') {
    response.end(readFileSync(new URL('../preview-host/bridge.js',import.meta.url)))
    return
  }
  if (request.url === '/__sandbox/request-policy.js') {
    response.end('self.SANDBOX_REQUEST_TIMEOUT_MS=10000')
    return
  }
  if (request.url === '/sw.js') {
    response.end(`self.addEventListener('fetch', event => {
      if (new URL(event.request.url).pathname === '/target')
        event.respondWith(${sourceResponse}.then(async response=>{await new Promise(resolve=>setTimeout(resolve,${delayMs}));return new Response(response.body,{status:response.status,headers:response.headers})}))
    })`)
    return
  }
  if (request.url === '/inspect.js') {
    response.setHeader('Content-Type','text/javascript')
    response.end(readFileSync(new URL('../preview-host/inspect.js',import.meta.url)))
    return
  }
  if (request.url === '/__sandbox/frame.js') {
    response.end(outerScript)
    return
  }
  if (request.url === '/outer' || request.url === '/__sandbox/frame.html') {
    if (externalOuter) response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'")
    const layout = outerLayout ? '<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style>' : ''
    response.end(externalOuter
      ? `<!doctype html>${layout}${preexistingInner ? '<iframe title="inner"></iframe>' : ''}<script src="/__sandbox/frame.js"></script>`
      : `<!doctype html>${layout}${preexistingInner ? '<iframe title="inner"></iframe>' : ''}<script>${outerScript}</script>`)
    return
  }
  if (request.url === '/bridge' || request.url === '/__sandbox/bridge.html') {
    response.end(`<!doctype html><script>
      navigator.serviceWorker.addEventListener('message', event => {
        if(event.data?.type==='request'&&event.ports[0]){
          ${parentBridge
            ? `parent.postMessage({fetch:true},'*',[event.ports[0]])`
            : binaryBody || realServiceWorker
            ? `const body=new TextEncoder().encode(${inlineTargetHTML}).buffer;event.ports[0].postMessage({${realServiceWorker ? `status:200,headers:${JSON.stringify(Object.entries(targetHeaders))},` : ''}body},[body])`
            : `event.ports[0].postMessage({body:${inlineTargetHTML}})`}
        }
      })
      ;(async()=>{await navigator.serviceWorker.register('${realServiceWorker ? '/__sandbox/sw.js' : '/sw.js'}'${realServiceWorker ? ",{scope:'/'}" : ''});await navigator.serviceWorker.ready;parent.postMessage({bridgeReady:true},'*')})()
    </script>`)
    return
  }
  if (request.url === '/target') {
    response.end('<!doctype html><button onclick="top.postMessage({clicked:true},String.fromCharCode(42))">network target</button>')
    return
  }
  if (request.url === '/owner') { response.end('<!doctype html>'); return }
  response.end(`<!doctype html>${ownerFrame ? `<iframe title="owner" src="http://localhost:${server.address().port}/owner" style="display:none"></iframe>` : ''}<iframe title="outer" sandbox="allow-scripts allow-same-origin" src="http://isolated.localhost:${server.address().port}${reservedOuter ? '/__sandbox/frame.html' : '/outer'}" width="260" height="130"></iframe><script>
    const outer=document.querySelector('iframe[title="outer"]')
    ${siblingBridge ? `outer.addEventListener('load',()=>{
      const bridge=document.createElement('iframe')
      bridge.src='http://isolated.localhost:${server.address().port}${realServiceWorker ? '/__sandbox/bridge.html' : '/bridge'}'
      ${realBridge ? `bridge.width='0';bridge.height='0';bridge.setAttribute('aria-hidden','true');bridge.setAttribute('sandbox','allow-scripts allow-same-origin')` : ''}
      ${realBridge ? `bridge.addEventListener('load',()=>{
        const channel=new MessageChannel()
        channel.port1.onmessage=event=>{
          if(event.data?.type==='ready')outer.contentWindow.postMessage({start:true},'*')
          else if(event.data?.type==='request'&&event.ports[0]){
            const body=new TextEncoder().encode(${inlineTargetHTML}).buffer
            event.ports[0].postMessage({status:200,headers:${JSON.stringify(Object.entries(targetHeaders))},body},[body])
          }
        }
        bridge.contentWindow.postMessage({type:'attach-workspace'},'http://isolated.localhost:${server.address().port}',[channel.port2])
      })` : ''}
      document.body.append(bridge)
    })` : ''}
    window.addEventListener('message', event => {
      ${parentBridge ? `if(event.data.fetch&&event.ports[0]){
        const body=new TextEncoder().encode(${inlineTargetHTML}).buffer
        event.ports[0].postMessage({status:200,headers:${JSON.stringify(Object.entries(targetHeaders))},body},[body])
      }` : ''}
      if(event.data.bridgeReady)outer.contentWindow.postMessage({start:true},'*')
      if(event.data.ready)window.ready=true
      if(event.data.clicked)window.clicked=true
    })
  </script>`)
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
try {
  const browserName = process.env.PROBE_BROWSER ?? 'firefox'
  const browserType = {chromium,firefox,webkit}[browserName]
  if (!browserType) throw Error(`Unsupported browser: ${browserName}`)
  const browser = await browserType.launch({headless:true})
  try {
    const page = await browser.newPage()
    page.on('pageerror', error => console.log('page error:',String(error)))
    page.on('console', message => { if(message.type()==='error')console.log('console error:',message.text()) })
    await page.goto(`http://${parentHost}:${server.address().port}/`,{waitUntil:'domcontentloaded',timeout:15000})
    const ready=await Promise.race([
      page.waitForFunction(() => window.ready === true, null, {timeout:10000}).then(()=>true,()=>false),
      new Promise(resolve=>setTimeout(()=>resolve(false),12000)),
    ])
    if (!ready) throw Error(`Preview did not become ready; frames=${JSON.stringify(page.frames().map(frame=>frame.url()))}`)
    const box = await page.locator('iframe[title="outer"]').boundingBox()
    if (!box) throw Error('Outer iframe missing')
    await page.screenshot({path:'/private/tmp/firefox-nested-preview.png'})
    await page.mouse.click(box.x + (outerLayout ? 45 : 55), box.y + (outerLayout ? 20 : 35))
    await page.waitForTimeout(300)
    const result = await page.evaluate(() => {
      const outer=document.querySelector('iframe[title="outer"]').contentWindow
      let innerAccessible=false,innerError
      try { innerAccessible=Boolean(outer.frames[0]) } catch(error) { innerError=String(error) }
      return {clicked:window.clicked === true,ready:window.ready === true,outerLength:outer.length,innerAccessible,innerError}
    })
    const frameStates=await Promise.all(page.frames().map(async frame=>({url:frame.url(),isolated:await frame.evaluate(()=>crossOriginIsolated).catch(error=>String(error))})))
    console.log(JSON.stringify({result,frames:frameStates,box}))
    if (!result.clicked) process.exitCode=1
  } finally { await browser.close() }
} finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())) }
