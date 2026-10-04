import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {chromium, firefox, webkit} from '@playwright/test'
import {sdkBrowserAssets} from '../scripts/sdk-browser-assets.mjs'
import {createNativeHTTPPressureServer} from './fixtures/native-http-pressure.mjs'

test('installed owner handles queued HTTP responses after cancellation in each desktop browser', {
  skip: process.env.NATIVE_OWNER_HTTP_PRESSURE !== '1' ? 'Opt-in installed owner HTTP pressure control' : false,
  timeout: 90000,
}, async () => {
  const sdk = process.env.NATIVE_SDK_BUNDLE_DIR, deployment = process.env.NATIVE_DEPLOYMENT_DIR
  assert.ok(sdk && deployment, 'Pass the installed SDK and prepared deployment')
  const root = resolve(process.env.NATIVE_SOURCE_ROOT ?? process.cwd())
  const {nativeReleaseAcceptanceIdentity} = await import(pathToFileURL(join(root, 'scripts/native-release-acceptance.mjs')).href)
  const before = nativeReleaseAcceptanceIdentity(root, sdk, deployment), assets = sdkBrowserAssets(sdk)
  const manifest = JSON.parse(await readFile(join(deployment, 'deployment-manifest.json'), 'utf8'))
  const deployed = new Map(manifest.files.map(file => ['/' + file.path, join(deployment, file.path)]))
  const workerPath = [...deployed.keys()].find(path => path.startsWith('/runtime/native/vite-8.3.1-') && path.endsWith('/engine.js'))
  assert.ok(workerPath, 'Missing installed Vite 8.3.1 runtime')
  const headers = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store'}
  let appOrigin
  const app = createServer(async (request, response) => {
    const file = assets.get(new URL(request.url, 'http://localhost').pathname)
    response.writeHead(200, {...headers, 'Content-Type': file ? 'text/javascript' : 'text/html'})
    response.end(file ? await readFile(file) : '<!doctype html><title>Installed owner HTTP pressure control</title>')
  })
  const owner = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const file = assets.get(path) ?? deployed.get(path)
    if (path === '/owner.html') {
      response.writeHead(200, {...headers, 'Content-Type': 'text/html'})
      response.end(`<!doctype html><script type="module">
        import {installNativeOwnerHost} from '/sdk/index.js';
        installNativeOwnerHost({allowedParentOrigin:${JSON.stringify(appOrigin)},workerURL:${JSON.stringify(workerPath)}});
        parent.postMessage('http-pressure-owner-ready',${JSON.stringify(appOrigin)});
      </script>`)
    } else if (file) {
      response.writeHead(200, {...headers, 'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'})
      response.end(await readFile(file))
    } else { response.writeHead(404); response.end() }
  })
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1',
    () => resolve('http://127.0.0.1:' + server.address().port)))
  appOrigin = await listen(app)
  const ownerOrigin = await listen(owner)
  const serverSource = `import {createServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    const {server}=(${createNativeHTTPPressureServer.toString()})(createServer,
      event=>{if(event.phase==='held-request'||event.phase==='finished')writeFileSync('/app/pressure-state.json',JSON.stringify(event))});
    server.listen(3000,'127.0.0.1');`
  try {
    for (const engine of [chromium, firefox, webkit]) {
      const browser = await engine.launch()
      try {
        const page = await browser.newPage()
        page.on('console', message => console.log(engine.name() + ' ' + message.text()))
        await page.goto(appOrigin)
        const result = await page.evaluate(async ({ownerOrigin, serverSource}) => {
          const {NativeOwnerClient} = await import('/sdk/index.js')
          const frame = document.createElement('iframe')
          frame.allow = 'cross-origin-isolated'
          const ready = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('Owner did not load')), 10000)
            const listener = event => {
              if(event.source !== frame.contentWindow || event.origin !== ownerOrigin || event.data !== 'http-pressure-owner-ready')return
              clearTimeout(timeout);removeEventListener('message',listener);resolve()
            }
            addEventListener('message',listener)
          })
          frame.src = ownerOrigin + '/owner.html'; document.body.append(frame); await ready
          const client = await NativeOwnerClient.connect(frame.contentWindow, ownerOrigin)
          const decode = new TextDecoder()
          const controllers = Array.from({length:32}, () => new AbortController())
          const reasons = controllers.map((_, index) => Error('Cancelled held request ' + index))
          let old = []
          const waitFor = async (predicate, label) => {
            const deadline = performance.now() + 5000
            while (!(await predicate())) {
              if(performance.now() >= deadline)throw Error(label)
              await new Promise(resolve => setTimeout(resolve,5))
            }
          }
          try {
            const port = await client.start({'/app/server.mjs':serverSource},
              {entry:'server.mjs',installDependencies:false,previewPort:3000})
            const origin = 'http://127.0.0.1:' + port
            const requests = controllers.map((controller,index) => new Request(origin+'/hold/'+index,{signal:controller.signal}))
            old = requests.map((request,index) => client.fetch(request).then(() => false,error => error === reasons[index]))
            await waitFor(async () => {
              try{return JSON.parse(decode.decode(await client.readFile('/app/pressure-state.json'))).held === 32}catch{return false}
            },'Held requests did not reach the installed guest server')
            const modules = Array.from({length:96},async (_,index) => {
              const response = await client.fetch(new Request(origin+'/module/'+index))
              if(index%4===0)await new Promise(resolve=>setTimeout(resolve,20))
              const bytes = new Uint8Array(await response.arrayBuffer())
              return response.status===200 && bytes.length===300*1024 && bytes.every(byte=>byte===index%251)
            })
            for(const [index,controller] of controllers.entries())controller.abort(reasons[index])
            const cancelled = await Promise.all(old), responses = await Promise.all(modules)
            await waitFor(async () => JSON.parse(decode.decode(await client.readFile('/app/pressure-state.json'))).finished === 96,
              'Installed guest responses did not finish')
            const state = JSON.parse(decode.decode(await client.readFile('/app/pressure-state.json')))
            const resources = await client.resources()
            return {cancelled:cancelled.filter(Boolean).length,responses:responses.filter(Boolean).length,state,resources,
              diagnostics:client.events.filter(event=>event.type==='diagnostic')}
          } finally {
            for(const [index,controller] of controllers.entries())controller.abort(reasons[index])
            await Promise.all(old); await client.dispose(); client.close(); frame.remove()
          }
        }, {ownerOrigin, serverSource})
        assert.equal(result.cancelled,32,engine.name())
        assert.equal(result.responses,96,engine.name())
        assert.deepEqual({...result.state,phase:undefined,count:undefined},
          {phase:undefined,count:undefined,received:128,finished:96,held:32},engine.name())
        assert.equal(result.resources.responseStreams,0,engine.name())
        assert.deepEqual(result.diagnostics,[],engine.name())
        assert.deepEqual(nativeReleaseAcceptanceIdentity(root,sdk,deployment),before,'Installed inputs changed')
        console.log(JSON.stringify({browser:engine.name(),version:browser.version(),result,passed:true}))
      } finally { await browser.close() }
    }
  } finally { await Promise.all([app,owner].map(server=>new Promise(resolve=>server.close(resolve)))) }
})
