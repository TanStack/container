import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { verifyDeploymentAssets } from './sdk-external-assets.mjs'
import { sdkBrowserAssets } from './sdk-browser-assets.mjs'

const deployment = process.env.NATIVE_DEPLOYMENT_DIR
const sdk = process.env.NATIVE_SDK_BUNDLE_DIR
const siteOrigin = process.env.NATIVE_SITE_ORIGIN ?? 'http://127.0.0.1:4198'
const ownerOrigin = process.env.NATIVE_OWNER_ORIGIN ?? 'http://127.0.0.1:4197'
const previewOrigin = process.env.NATIVE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4199'
const testSite = process.env.NATIVE_TEST_SITE === '1'
if (!deployment || !sdk) throw Error('Set NATIVE_DEPLOYMENT_DIR and NATIVE_SDK_BUNDLE_DIR')
const deploymentManifest = JSON.parse(await readFile(join(deployment, 'deployment-manifest.json'), 'utf8'))
const require = createRequire(join(resolve(sdk), 'package.json'))
const runtime = dirname(require.resolve('@tanstack/browser-sandbox-runtime-experimental/setup'))
const runtimeInventoryBytes = await readFile(join(runtime, 'package-assets.json'))
const packageManifestSHA256 = createHash('sha256').update(runtimeInventoryBytes).digest('hex')
verifyDeploymentAssets(deployment, deploymentManifest, { packageManifestSHA256, expectedFiles: deploymentManifest.files })
const deployedFiles = new Map(deploymentManifest.files.map(file => [file.path, file]))
for (const file of JSON.parse(runtimeInventoryBytes).files.filter(file => /^(?:runtime|preview-host)\//.test(file.path))) {
  const deployed = deployedFiles.get(file.path)
  if (deployed?.bytes !== file.bytes || deployed?.sha256 !== file.sha256)
    throw Error('Prepared deployment differs from the installed runtime: ' + file.path)
}
const {createNativeOwnerHostAssets,readNativeRuntimeCandidates} = await import(pathToFileURL(join(sdk,'assets.mjs')).href)
if(typeof readNativeRuntimeCandidates !== 'function')
  throw Error('Native site hosting requires an installed split SDK with the runtime catalog assets API')
const runtimeCandidates = readNativeRuntimeCandidates()
for (const candidate of runtimeCandidates) {
  if (!deploymentManifest.files.some(file => '/' + file.path === candidate.workerURL))
    throw Error('Prepared deployment is missing the selected native worker: ' + candidate.workerURL)
}
const buildId = createHash('sha256').update(await readFile(join(sdk, 'package-assets.json'))).digest('hex')
const sdkAssets = sdkBrowserAssets(sdk)
const ownerAssets = createNativeOwnerHostAssets({
  buildId,
  parentOrigin: siteOrigin,
  previewOrigin,
  previewHostSuffix: process.env.NATIVE_PREVIEW_HOST_SUFFIX,
  workerPath: runtimeCandidates[0].workerURL,
  runtimeCandidates,
})

const headers = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}
const mime = path => path.endsWith('.wasm') ? 'application/wasm'
  : path.endsWith('.html') ? 'text/html'
  : path.endsWith('.json') ? 'application/json'
  : 'text/javascript'

const owner = createServer(async (request, response) => {
  Object.entries(headers).forEach(([name, value]) => response.setHeader(name, value))
  const path = new URL(request.url, ownerOrigin).pathname
  if (request.method !== 'GET') { response.writeHead(405).end(); return }
  const ownerFile = ownerAssets.files[path]
  if (ownerFile !== undefined) {
    response.writeHead(200, ownerAssets.headers[path])
    response.end(ownerFile)
    return
  }
  const runtimeRoot = resolve(deployment, 'runtime')
  const nativeFile = /^\/runtime\/(?:native|workers|mvdan-shell)\/[A-Za-z0-9._/-]+$/.test(path)
    ? resolve(deployment, path.slice(1)) : undefined
  const file = sdkAssets.get(path) ?? (nativeFile?.startsWith(runtimeRoot + sep) ? nativeFile : undefined)
  if (!file) { response.writeHead(404).end(); return }
  try {
    response.setHeader('Content-Type', mime(path))
    response.end(await readFile(file))
  } catch { response.writeHead(404).end() }
})

const preview = createServer(async (request, response) => {
  Object.entries(headers).forEach(([name, value]) => response.setHeader(name, value))
  const path = new URL(request.url, previewOrigin).pathname
  const name = path.startsWith('/__sandbox/') ? path.slice('/__sandbox/'.length) : ''
  if (request.method !== 'GET' || !['bridge.html', 'bridge.js', 'sw.js', 'inspect.js', 'websocket.js', 'request-policy.js'].includes(name)) {
    response.writeHead(503).end('No workspace attached')
    return
  }
  const root = resolve(deployment, 'preview-host/__sandbox')
  const file = resolve(root, name)
  if (!file.startsWith(root + sep)) { response.writeHead(404).end(); return }
  response.setHeader('Content-Type', mime(name))
  response.setHeader('Service-Worker-Allowed', '/')
  if (name === 'bridge.html') response.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
  try { response.end(await readFile(file)) }
  catch { response.writeHead(404).end() }
})

await Promise.all([
  new Promise(resolve => owner.listen(Number(new URL(ownerOrigin).port), '127.0.0.1', resolve)),
  new Promise(resolve => preview.listen(Number(new URL(previewOrigin).port), '127.0.0.1', resolve)),
  ...(testSite ? [new Promise(resolve => {
    const site = createServer(async (request, response) => {
      Object.entries({...headers,'Cross-Origin-Opener-Policy':'same-origin'}).forEach(([name,value]) => response.setHeader(name,value))
      const path = new URL(request.url,siteOrigin).pathname
      if(request.method !== 'GET'){response.writeHead(405).end();return}
      if(path === '/'){
        response.setHeader('Content-Type','text/html; charset=utf-8')
        response.end('<!doctype html><meta charset="utf-8"><title>Native owner test</title>')
      }else if(sdkAssets.has(path)){
        response.setHeader('Content-Type','text/javascript')
        response.end(await readFile(sdkAssets.get(path)))
      }else response.writeHead(404).end()
    })
    site.listen(Number(new URL(siteOrigin).port),'127.0.0.1',resolve)
  })] : []),
])
console.log(`Native owner ${ownerOrigin} and preview ${previewOrigin}${testSite?` with test site ${siteOrigin}`:''}`)
