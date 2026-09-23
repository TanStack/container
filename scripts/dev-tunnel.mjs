import { spawn } from 'node:child_process'
import { mkdtemp, appendFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const binary = process.argv[2] ? resolve(process.argv[2]) : 'cloudflared'
if (process.argv[2]) await access(binary)
const directory = await mkdtemp(join(tmpdir(), 'sandbox-phone-session-'))
const logPath = join(directory, 'session.log')
const children = new Set()
let stopping = false
let logQueue = Promise.resolve()
const log = text => {
  process.stdout.write(text)
  logQueue = logQueue.then(() => appendFile(logPath, text)).catch(error => console.error(error.message))
}
const stop = code => {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') console.error(error) }
  }
  process.exitCode = code
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0))
function launch(command, args, env = {}, onOutput = () => {}, transient = false) {
  if (stopping) throw new Error('Session stopped')
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    const text = chunk.toString()
    log(text)
    onOutput(text)
  })
  child.on('error', error => { log(`Launch failed: ${error.message}\n`); stop(1) })
  child.on('exit', (code, signal) => {
    children.delete(child)
    log(`${command} exited: ${code ?? signal}\n`)
    if (!stopping && (!transient || code !== 0)) stop(1)
  })
  return child
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(url, timeout = 60000) {
  const deadline = Date.now() + timeout
  let lastError = 'No response'
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      await response.body?.cancel()
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) { lastError = error.cause?.message ?? error.message }
    await pause(1000)
  }
  throw new Error(`Server did not become ready: ${url} (${lastError})`)
}
function tunnel(port, hostHeader = false) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tunnel did not publish a URL')), 60000)
    let output = ''
    const child = launch(binary, ['tunnel', '--no-autoupdate', ...(hostHeader ? ['--http-host-header', 'localhost'] : []), '--url', `http://127.0.0.1:${port}`], {}, chunk => {
      output = (output + chunk).slice(-16000)
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match && output.includes('Registered tunnel connection')) { clearTimeout(timer); resolve(match[0]) }
    })
    child.once('error', reject)
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Tunnel stopped')) })
  })
}
async function publicReady(origin, path) {
  // Quick Tunnel registration can precede DNS publication. An early lookup can
  // cache NXDOMAIN for 30 minutes, so allow provisioning before the first lookup.
  log(`Allowing DNS publication: ${origin}\n`)
  await pause(30000)
  log(`Waiting for HTTPS: ${origin}${path}\n`)
  await waitFor(origin + path, 240000)
}
try {
  log(`Sandbox phone session\nLog: ${logPath}\nKeep this Terminal window open and your Mac awake. Press Ctrl+C to stop all session processes.\n`)
  launch(process.execPath, ['scripts/serve-preview-host.mjs'], { SANDBOX_PREVIEW_HOST: '127.0.0.1', SANDBOX_PREVIEW_PORT: '4174', SANDBOX_TLS_CERT: '', SANDBOX_TLS_KEY: '' })
  await waitFor('http://127.0.0.1:4174/__sandbox/health')
  const preview = await tunnel(4174)
  const build = launch('npm', ['run', 'build', '--', '--outDir', join(directory, 'site')], { VITE_SANDBOX_PREVIEW_ORIGIN: preview }, () => {}, true)
  await new Promise((resolve, reject) => {
    build.once('error', reject)
    build.once('exit', code => code === 0 ? resolve() : reject(new Error('Lab build failed')))
  })
  launch(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4184', '--strictPort', '--outDir', join(directory, 'site')])
  await waitFor('http://127.0.0.1:4184/sandbox.html')
  const lab = await tunnel(4184, true)
  await publicReady(preview, '/__sandbox/health')
  await publicReady(lab, '/sandbox.html')
  log(`\nREADY\nPhone: ${lab}/sandbox.html\nPreview: ${preview}\nPublic test links, no sensitive projects.\n`)
} catch (error) {
  log(`Session failed: ${error.stack ?? error}\n`)
  stop(1)
}
