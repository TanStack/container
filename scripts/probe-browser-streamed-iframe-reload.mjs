import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'
import { diagnosticWithin } from './native-browser-diagnostic.mjs'

export function streamedIframePlan(env = process.env) {
  const browsers = env.NATIVE_BROWSER ? [env.NATIVE_BROWSER] : ['chromium', 'firefox', 'webkit']
  assert.ok(browsers.every(name => ['chromium', 'firefox', 'webkit'].includes(name)), 'Unknown browser engine')
  const repetitions = Number(env.NATIVE_RELOAD_REPETITIONS ?? 10)
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 50, 'NATIVE_RELOAD_REPETITIONS must be an integer from 1 to 50')
  const transports = env.NATIVE_RELOAD_TRANSPORTS?.split(',') ?? ['network', 'service-worker', 'message-port']
  assert.ok(transports.length > 0 && new Set(transports).size === transports.length &&
    transports.every(name => ['network', 'service-worker', 'message-port'].includes(name)), 'Use unique known reload transports')
  assert.ok(env.NATIVE_RELOAD_HISTORY === undefined || ['0', '1'].includes(env.NATIVE_RELOAD_HISTORY), 'NATIVE_RELOAD_HISTORY must be 0 or 1')
  const input = env.NATIVE_RELOAD_INPUT ?? 'textarea'
  assert.ok(['textarea', 'xterm'].includes(input), 'NATIVE_RELOAD_INPUT must be textarea or xterm')
  assert.ok(input !== 'xterm' || env.NATIVE_RELOAD_XTERM_ROOT, 'Pass an installed @xterm/xterm directory')
  return { browsers, repetitions, transports, history: env.NATIVE_RELOAD_HISTORY === '1', input }
}

export function readReloadXterm(root) {
  const manifestBytes = readFileSync(join(root, 'package.json'))
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.name, '@xterm/xterm')
  assert.equal(manifest.version, '5.5.0', 'Match the installed site terminal version')
  assert.equal(manifest.main, 'lib/xterm.js')
  const assets = {
    '/xterm.js': { bytes: readFileSync(join(root, 'lib/xterm.js')), type: 'text/javascript' },
    '/xterm.css': { bytes: readFileSync(join(root, 'css/xterm.css')), type: 'text/css' },
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  return { assets, identity: { name: manifest.name, version: manifest.version,
    manifestSHA256: hash(manifestBytes), files: Object.fromEntries(Object.entries(assets).map(([path, asset]) => [path, hash(asset.bytes)])) } }
}

async function main() {
  const plan = streamedIframePlan()
  const xterm = plan.input === 'xterm' ? readReloadXterm(process.env.NATIVE_RELOAD_XTERM_ROOT) : undefined
  let count = 0, previewOrigin
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  }
  const parent = createServer((request, response) => {
    const asset = xterm?.assets[request.url]
    if (asset) {
      response.writeHead(200, { ...headers, 'Content-Type': asset.type })
      response.end(asset.bytes)
      return
    }
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html' })
    if (request.url === '/source') { streamHTML(response); return }
    response.end(`<!doctype html><title>Streamed iframe reload control</title>
      ${xterm ? '<link rel="stylesheet" href="/xterm.css"><script src="/xterm.js"></script>' : ''}
      <button id="toggle">Toggle editor</button><div id="editor">${xterm ? '<div id="terminal"></div>' : '<textarea aria-label="Command"></textarea>'}</div>
      <input type="range" aria-label="Preview height" min="200" max="600" step="20" value="400">
      <div id="preview" style="height:400px"></div>`)
  })
  const preview = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const script = url.pathname.endsWith('.js')
    response.writeHead(200, { ...headers, 'Content-Type': script ? 'text/javascript' : 'text/html',
      'X-Stream-Control': 'network',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'",
      ...(url.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    })
    if (url.pathname === '/sw.js') {
      response.end(`addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
        addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
        addEventListener('fetch',event=>{
          if(new URL(event.request.url).pathname!=='/app')return;
          if(${JSON.stringify(plan.transports)}.includes('message-port')&&new URL(event.request.url).searchParams.get('transport')==='message-port'){
            event.respondWith((async()=>{
              const bridges=(await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(client=>new URL(client.url).pathname==='/bootstrap');
              if(bridges.length!==1)throw Error('Expected one stream bridge');
              return new Promise((resolve,reject)=>{
                const channel=new MessageChannel();let controller,streaming=false;
                const timer=setTimeout(()=>{
                  const error=Error('Stream bridge timed out');
                  channel.port1.postMessage({type:'cancel'});channel.port1.close();
                  streaming?controller.error(error):reject(error);
                },10000);
                channel.port1.onmessage=({data})=>{
                  if(data.type==='headers'){
                    streaming=true;
                    const body=new ReadableStream({start(value){controller=value},pull(){channel.port1.postMessage({type:'pull'})},cancel(){clearTimeout(timer);channel.port1.postMessage({type:'cancel'});channel.port1.close()}});
                    resolve(new Response(body,{headers:data.headers}));
                  }else if(data.type==='chunk')controller.enqueue(new Uint8Array(data.body));
                  else if(data.type==='done'){clearTimeout(timer);controller.close();channel.port1.close()}
                  else if(data.type==='error'){clearTimeout(timer);streaming?controller.error(Error(data.error)):reject(Error(data.error));channel.port1.close()}
                };
                channel.port1.start();bridges[0].postMessage({type:'stream-control-request'},[channel.port2]);
              });
            })());return;
          }
          event.respondWith(fetch('/source').then(source=>{const headers=new Headers(source.headers);
            headers.set('X-Stream-Control','service-worker');return new Response(source.body,{headers})}))
        });`)
    } else if (url.pathname === '/bootstrap') {
      response.end('<!doctype html><script src="/bootstrap.js"></script>')
    } else if (url.pathname === '/bootstrap.js') {
      response.end(`navigator.serviceWorker.addEventListener('message',event=>{
        if(event.data?.type==='stream-control-request'&&event.ports[0])parent.postMessage(event.data,${JSON.stringify(parentOrigin)},[event.ports[0]])
      });
        (async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
        if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
        parent.postMessage({type:'stream-control-ready'},${JSON.stringify(parentOrigin)})})()`)
    } else if (url.pathname === '/app.js') {
      response.end(`const button=document.querySelector('button');
        button.addEventListener('click',()=>{button.textContent=String(Number(button.textContent)+1)});
        ${plan.history ? "history.replaceState({key:'stream-control',index:0},'',location.href);" : ''}
        parent.postMessage({type:'stream-control-document',value:button.textContent},${JSON.stringify(parentOrigin)});`)
    } else if (url.pathname === '/app' || url.pathname === '/source') {
      streamHTML(response)
    } else response.end('<!doctype html>')
  })
  const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  function streamHTML(response) {
    // Each response is a real timed stream, not document.write or srcdoc.
    const parts = ['<!doctype html><html><head><title>Counter</title></head><body>',
      `<button>${count}</button>`, '<script src="/app.js"></script></body></html>']
    let index = 0
    const send = () => {
      if (response.destroyed) return
      response.write(parts[index++])
      if (index === parts.length) response.end()
      else setTimeout(send, 20)
    }
    send()
  }
  let parentOrigin
  try {
    await listen(parent)
    parentOrigin = `http://127.0.0.1:${parent.address().port}`
    await listen(preview)
    previewOrigin = `http://127.0.0.1:${preview.address().port}`
    for (const name of plan.browsers) for (const transport of plan.transports) {
      const appURL = previewOrigin + '/app' + (transport === 'message-port' ? '?transport=message-port' : '')
      const browser = await { chromium, firefox, webkit }[name].launch({ headless: true })
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      const errors = [], documents = [], traces = []
      let attempt = 0, frame
      page.on('pageerror', error => errors.push({ attempt, error: String(error) }))
      page.on('console', message => {
        if (message.text().startsWith('[streamed-iframe] ')) traces.push({ attempt, text: message.text() })
      })
      await page.addInitScript(origin => {
        if (location.origin === origin && location.pathname === '/app') console.log('[streamed-iframe] ' + performance.timeOrigin)
      }, previewOrigin)
      try {
        await page.goto(parentOrigin)
        await page.evaluate(async ({ previewOrigin, transport, input }) => {
          globalThis.streamedIframeDocuments = []
          addEventListener('message', event => {
            if (event.origin === previewOrigin && event.source === document.querySelector('iframe[title="Preview"]')?.contentWindow && event.data?.type === 'stream-control-document')
              globalThis.streamedIframeDocuments.push(event.data)
          })
          if (transport !== 'network') {
            const bootstrap = document.createElement('iframe')
            bootstrap.title = 'Service worker bootstrap'
            bootstrap.width = bootstrap.height = '0'
            bootstrap.setAttribute('sandbox', 'allow-scripts allow-same-origin')
            const ready = new Promise((resolve, reject) => {
              const timer = setTimeout(() => { removeEventListener('message', listener); reject(Error('Service worker bootstrap timed out')) }, 15000)
              const listener = event => {
                if (event.origin === previewOrigin && event.source === bootstrap.contentWindow && event.data?.type === 'stream-control-ready') {
                  clearTimeout(timer); removeEventListener('message', listener); resolve()
                }
              }
              addEventListener('message', listener)
            })
            bootstrap.src = previewOrigin + '/bootstrap'
            document.body.append(bootstrap)
            await ready
            if (transport === 'message-port') addEventListener('message', async event => {
              if (event.origin !== previewOrigin || event.source !== bootstrap.contentWindow || event.data?.type !== 'stream-control-request' || !event.ports[0]) return
              const port = event.ports[0]
              let reader
              try {
                const response = await fetch('/source')
                reader = response.body.getReader()
                // One pull, one transferred chunk, just like the SDK handoff.
                port.onmessage = async ({ data }) => {
                  try {
                    if (data.type === 'cancel') { await reader.cancel(); port.close(); return }
                    if (data.type !== 'pull') return
                    const chunk = await reader.read()
                    if (chunk.done) { port.postMessage({ type: 'done' }); port.close(); return }
                    const body = chunk.value.buffer.slice(chunk.value.byteOffset, chunk.value.byteOffset + chunk.value.byteLength)
                    port.postMessage({ type: 'chunk', body }, [body])
                  } catch (error) { port.postMessage({ type: 'error', error: String(error) }); port.close() }
                }
                port.start()
                port.postMessage({ type: 'headers', headers: [
                  ['Content-Type', 'text/html'], ['X-Stream-Control', 'message-port'],
                  ['Cross-Origin-Embedder-Policy', 'require-corp'], ['Cross-Origin-Resource-Policy', 'cross-origin'],
                  ['Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'"],
                ] })
              } catch (error) { port.postMessage({ type: 'error', error: String(error) }); port.close() }
            })
          }
          const frame = document.createElement('iframe')
          frame.title = 'Preview'
          frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
          frame.referrerPolicy = 'no-referrer'
          frame.style.cssText = 'width:100%;height:100%;border:0'
          document.querySelector('#preview').append(frame)
          document.querySelector('#toggle').onclick = () => {
            const editor = document.querySelector('#editor')
            editor.hidden = !editor.hidden
          }
          document.querySelector('input').oninput = event => {
            document.querySelector('#preview').style.height = event.target.value + 'px'
            if (globalThis.reloadTerminal) globalThis.reloadTerminal.resize(55, Number(event.target.value) / 20)
          }
          if (input === 'xterm') {
            // Real terminal input/rendering only, deliberately no pretend shell,
            // SDK or framework. This isolates browser focus and key dispatch.
            const terminal = new Terminal({ cols: 55, rows: 10, convertEol: true })
            terminal.open(document.querySelector('#terminal'))
            terminal.textarea.ariaLabel = 'Command'
            globalThis.reloadTerminal = terminal
            globalThis.reloadTerminalInput = []
            terminal.onData(data => {
              globalThis.reloadTerminalInput.push(data)
              if (data === '\f') terminal.clear()
              else if (data === '\r' || data === '\u0003') terminal.write('\r\n')
              else if (!data.includes('\u001b') && data >= ' ') terminal.write(data)
            })
          }
        }, { previewOrigin, transport, input: plan.input })
        frame = await (await page.locator('iframe[title="Preview"]').elementHandle()).contentFrame()
        assert.ok(frame, 'App iframe missing')
        for (attempt = 0; attempt <= plan.repetitions; attempt++) {
          count = 40 + attempt * 10
          const command = page.getByRole('textbox', { name: 'Command' })
          if (plan.input === 'xterm') {
            await command.focus()
            await page.evaluate(() => { globalThis.reloadTerminalInput = [] })
            await page.keyboard.type('x'.repeat(100))
          } else await command.fill('x'.repeat(100))
          await command.press('Home'); await command.press('End'); await command.press('ArrowLeft')
          await command.press('Y'); await command.press('Control+L')
          if (plan.input === 'xterm') {
            await command.press('Control+W'); await command.press('Alt+Backspace'); await command.press('Control+C')
            const data = await page.evaluate(() => globalThis.reloadTerminalInput)
            assert.ok(data.join('').includes('x'.repeat(100)), 'Wrapped input did not reach xterm')
            for (const key of ['Y', '\f', '\u0017', '\u0003']) assert.ok(data.includes(key), 'Missing xterm input ' + JSON.stringify(key))
            assert.ok(data.some(value => value.startsWith('\u001b')), 'Navigation keys did not reach xterm')
          }
          await page.getByRole('button', { name: 'Toggle editor' }).click()
          await page.getByRole('button', { name: 'Toggle editor' }).click()
          const handle = page.getByRole('slider', { name: 'Preview height' })
          await handle.click()
          await handle.press('ArrowUp')
          const [response] = await Promise.all([
            page.waitForResponse(response => response.url() === appURL, { timeout: 10000 }),
            page.evaluate(url => { document.querySelector('iframe[title="Preview"]').src = url }, appURL),
          ])
          assert.equal(response.status(), 200)
          assert.equal(await response.headerValue('x-stream-control'), transport, 'Navigation used the wrong transport')
          await frame.getByRole('button', { name: String(count), exact: true }).waitFor({ timeout: 10000 })
          // The streamed button arrives before its external listener script.
          // Readiness does not replace the real frame click and value assertion.
          await page.waitForFunction(value => globalThis.streamedIframeDocuments.some(item => item.value === value), String(count), { timeout: 10000 })
          await frame.getByRole('button', { name: String(count), exact: true }).click({ timeout: 10000 })
          await frame.getByRole('button', { name: String(count + 1), exact: true }).waitFor({ timeout: 10000 })
          console.log(JSON.stringify({ browser: name, transport, reload: attempt, value: count + 1 }))
        }
        assert.deepEqual(errors, [])
        console.log(JSON.stringify({ browser: name, transport, input: plan.input, xterm: xterm?.identity,
          history: plan.history, reloads: plan.repetitions, passed: true, documentStarts: traces.length }))
      } catch (error) {
        const observed = await diagnosticWithin(() => page.evaluate(() => globalThis.streamedIframeDocuments))
        if (Array.isArray(observed)) documents.push(...observed)
        console.error(JSON.stringify({ browser: name, transport, attempt, error: String(error), errors, documents, traces, frameDetached: frame?.isDetached() }))
        throw error
      } finally { await browser.close() }
    }
  } finally {
    await Promise.all([parent, preview].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
