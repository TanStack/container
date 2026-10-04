import { createServer } from 'node:http'
import { firefox } from '@playwright/test'

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html')
  if (process.env.PROBE_COOP === '1') response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  if (process.env.PROBE_COEP === '1') response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  if (request.url === '/target' && process.env.PROBE_CORP === '1') response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  if (request.url === '/target') {
    response.end('<!doctype html><button onclick="parent.postMessage({clicked:location.hostname},\'*\')">click me</button>')
    return
  }
  response.end(`<!doctype html>
    <iframe title="localhost" src="http://localhost:${server.address().port}/target"></iframe>
    <iframe title="subdomain" src="http://isolated.localhost:${server.address().port}/target"></iframe>
    <iframe title="sandboxed-subdomain" sandbox="allow-scripts allow-same-origin" src="http://sandboxed.localhost:${server.address().port}/target"></iframe>
    <script>window.clicks=[];window.addEventListener('message',event=>{window.clicks.push(event.data.clicked)})</script>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const browser = await firefox.launch({ headless:true })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    for (const title of ['localhost','subdomain','sandboxed-subdomain']) {
      const frame = page.locator(`iframe[title="${title}"]`)
      const box = await frame.boundingBox()
      if (!box) throw Error(`${title} iframe is missing`)
      await page.mouse.click(box.x + 40, box.y + 20)
      await page.waitForTimeout(300)
      const clicks = await page.evaluate(() => window.clicks)
      console.log(JSON.stringify({title,clicks,box,frameURLs:page.frames().map(frame=>frame.url())}))
    }
  } finally { await browser.close() }
} finally { await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve())) }
