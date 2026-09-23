import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const host = process.argv[2]
const addresses = Object.values(networkInterfaces()).flat().filter(Boolean)
if (
  !addresses.some(
    (address) =>
      address.family === 'IPv4' &&
      !address.internal &&
      address.address === host,
  )
)
  throw new Error(
    "Pass this Mac's active LAN IPv4 address: npm run dev:lan -- 192.168.x.x",
  )
if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host))
  throw new Error('Expected a private LAN address')

// Keys live outside Vite's workspace and public directories, with owner-only permissions.
// Nothing is installed in the Mac's keychain. The phone's trust step is manual.
process.umask(0o077)
const directory = await mkdtemp(join(tmpdir(), 'browser-sandbox-lan-'))
const rootCert = join(directory, 'root-ca.pem')
const rootKey = join(directory, 'root-ca-key.pem')
const cert = join(directory, 'server.pem')
const key = join(directory, 'server-key.pem')
const csr = join(directory, 'server.csr')
const publicCert = join(directory, 'sandbox-test-ca.cer')
const name = `Browser Sandbox Wi-Fi Test ${randomBytes(3).toString('hex')}`
const openssl = (...args) => {
  const result = spawnSync('openssl', args, { encoding: 'utf8' })
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr)
  return result.stdout.trim()
}
openssl(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-noenc',
  '-sha256',
  '-days',
  '7',
  '-subj',
  `/CN=${name}`,
  '-keyout',
  rootKey,
  '-out',
  rootCert,
  '-addext',
  'basicConstraints=critical,CA:TRUE,pathlen:0',
  '-addext',
  'keyUsage=critical,keyCertSign,cRLSign',
)
openssl(
  'req',
  '-new',
  '-newkey',
  'rsa:2048',
  '-noenc',
  '-sha256',
  '-subj',
  `/CN=${host}`,
  '-keyout',
  key,
  '-out',
  csr,
  '-addext',
  `subjectAltName=IP:${host}`,
  '-addext',
  'basicConstraints=critical,CA:FALSE',
  '-addext',
  'keyUsage=critical,digitalSignature,keyEncipherment',
  '-addext',
  'extendedKeyUsage=serverAuth',
)
openssl(
  'x509',
  '-req',
  '-in',
  csr,
  '-CA',
  rootCert,
  '-CAkey',
  rootKey,
  '-set_serial',
  '0x' + randomBytes(16).toString('hex'),
  '-days',
  '7',
  '-sha256',
  '-copy_extensions',
  'copy',
  '-out',
  cert,
)
openssl('verify', '-CAfile', rootCert, '-verify_ip', host, cert)
openssl('x509', '-in', rootCert, '-outform', 'DER', '-out', publicCert)
const fingerprint = openssl(
  'x509',
  '-in',
  rootCert,
  '-noout',
  '-fingerprint',
  '-sha256',
)
const certificate = await readFile(publicCert)
const lab = `https://${host}:4443/sandbox.html`
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox Wi-Fi setup</title><style>body{font:17px/1.5 system-ui;max-width:38rem;margin:2rem auto;padding:0 1rem}li{margin:1rem 0}code{overflow-wrap:anywhere}a{color:#165cbd}</style></head><body>
<h1>Sandbox Wi-Fi setup</h1>
<p>Stay on the same Wi-Fi as the Mac. Safari needs a trusted HTTPS connection for the preview's service worker.</p>
<ol>
<li><a href="/sandbox-test-ca.cer">Download the test certificate</a>, then allow the download.</li>
<li>In Settings, open <strong>Profile Downloaded</strong> and install <strong>${name}</strong>. If needed, look under General → VPN &amp; Device Management.</li>
<li>Open Settings → General → About → Certificate Trust Settings and enable full trust for <strong>${name}</strong>.</li>
<li>Return to Safari and <a href="${lab}">open the lab</a>. Try <strong>Run workflow in QuickJS</strong>, then <strong>Run Start app</strong>.</li>
</ol>
<p>This test CA expires in 7 days. Trusting it allows certificates signed by its private key, which stays on this Mac. Do not use sensitive projects. After testing, remove this profile in General → VPN &amp; Device Management. No VPN or device management enrollment is installed.</p>
<p><a href="https://support.apple.com/en-us/102390">Apple's certificate trust instructions</a></p>
<details><summary>Certificate fingerprint</summary><code>${fingerprint}</code><p>Compare this with the fingerprint in the Mac's terminal before trusting the certificate.</p></details>
</body></html>`
const setup = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  if (request.method !== 'GET') {
    response.writeHead(405)
    response.end()
    return
  }
  if (request.url === '/sandbox-test-ca.cer') {
    response.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="sandbox-test-ca.cer"',
    })
    response.end(certificate)
  } else if (request.url === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    })
    response.end(html)
  } else {
    response.writeHead(404)
    response.end('Not found')
  }
})
await new Promise((resolve, reject) => {
  setup.once('error', reject)
  setup.listen(4442, host, resolve)
})
const env = {
  ...process.env,
  SANDBOX_TLS_CERT: cert,
  SANDBOX_TLS_KEY: key,
  SANDBOX_PREVIEW_HOST: host,
  SANDBOX_PREVIEW_PORT: '4444',
  VITE_SANDBOX_PREVIEW_ORIGIN: `https://${host}:4444`,
}
const children = [
  spawn(process.execPath, ['scripts/serve-preview-host.mjs'], {
    env,
    stdio: 'inherit',
  }),
  spawn(
    'npm',
    ['run', 'dev', '--', '--host', host, '--port', '4443', '--strictPort'],
    { env, stdio: 'inherit', detached: true },
  ),
]
let stopping = false
const stop = (code = 0) => {
  if (stopping) return
  stopping = true
  setup.close()
  children[0].kill('SIGTERM')
  if (children[1].pid) {
    try {
      process.kill(-children[1].pid, 'SIGTERM')
    } catch {}
  }
  process.exitCode = code
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message)
    stop(1)
  })
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1)
  })
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
console.log(
  `Phone setup: http://${host}:4442/\nLab: ${lab}\nCertificate: ${name}\n${fingerprint}\nPrivate certificate directory: ${directory}\nA new launch creates a new test CA. Remove the old phone profile when finished.`,
)
