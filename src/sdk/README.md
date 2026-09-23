# Browser sandbox SDK

Experimental alpha package. This is not a complete Node runtime or
a production security boundary for arbitrary untrusted projects. Vite and
TanStack Start claims are limited to the exact workflows marked passed in the
package's `candidate-compatibility.json`. Playwright WebKit never counts as
Safari evidence; a Safari claim requires a separate actual Safari result.

Published alphas install by exact version:

```sh
npm install @tanstack/browser-sandbox-experimental@<alpha-version> --ignore-scripts
```

Do not install an unpinned alpha in production.

After the first alpha is published, its packaged examples can be copied and
run without this source repository:

```sh
mkdir browser-sandbox-alpha && cd browser-sandbox-alpha
npm init -y
npm install @tanstack/browser-sandbox-experimental@0.1.0-alpha.0 --ignore-scripts
cp -R node_modules/@tanstack/browser-sandbox-experimental/examples/basic ./basic
cp -R node_modules/@tanstack/browser-sandbox-experimental/examples/frameworks ./frameworks
```

The version above identifies the intended first alpha, it is not a statement
that npm publication has happened. Run `npm start` inside either copied folder.

## Install a local artifact

Use an SDK directory produced by the project's build, not the source checkout.
Replace `SDK_DIRECTORY` with its absolute path:

```sh
node SDK_DIRECTORY/verify-sdk.mjs SDK_DIRECTORY
npm pack SDK_DIRECTORY --ignore-scripts
npm install ./tanstack-browser-sandbox-experimental-*.tgz --ignore-scripts
```

Keep `manifest.json` with your test results. It records the build profile and
file hashes. `api-contract.json`, `compatibility-policy.json` and the TypeScript
declarations describe the public API. Ordinary local candidates are private and
versioned `0.0.0`, so do not treat that version as a unique build identifier.
Public artifacts carry an explicit alpha version and project license.

Leave `profileJobs` disabled for normal apps and performance checks. It is a
fine-grained profiler that changes the guest job batch size from 100 to 1 and
adds scheduling overhead. Use `diagnostics: true` for execution counters without
enabling that per-job mode.

## Host the runtime

Run this in your host project's Node build step. Create `public/` first and
choose a new destination. The helper verifies the package and refuses to
overwrite an existing directory.

```js
import { copyRuntimeAssets } from '@tanstack/browser-sandbox-experimental/assets'

copyRuntimeAssets('./public/sandbox-runtime')
```

Serve that directory at `/sandbox-runtime/` on your application's origin,
preserving its contents and paths. Serve JavaScript as JavaScript and `.wasm`
as `application/wasm`, without an HTML fallback for missing assets. Use HTTPS
for deployed hosts. Localhost can be used for development.

## Select the packaged Vite or Start runtime

Do not copy engine names or experimental compiler settings into your app.
Resolve them from the installed package's `manifest.json`. The resolver only
accepts build profiles and artifacts known by this SDK version, and it rejects
missing or malformed compiler, parser and engine declarations.

Use these helpers in the Node server that hosts your owner page. Call
`applySandboxOwnerHeaders` on the HTML response before sending the owner
document. Headers on the runtime-profile JSON response alone do not isolate
the owner page.

```ts
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSDKRuntimeProfile } from '@tanstack/browser-sandbox-experimental'

const packageRoot = dirname(fileURLToPath(
  import.meta.resolve('@tanstack/browser-sandbox-experimental'),
))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf8'))
const runtime = resolveSDKRuntimeProfile(manifest, 'tanstack-start')

function applySandboxOwnerHeaders(response: ServerResponse) {
  for (const [name, value] of Object.entries(runtime.ownerHeaders)) {
    response.setHeader(name, value)
  }
}

function sendRuntimeProfile(response: ServerResponse) {
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(runtime))
}
```

Pass the serialized result to browser code, check the browser environment, and
spread its owner-controlled options into `AgentSession` or `WorkerKernel`:

```ts
import {
  AgentSession,
  assertSDKRuntimeEnvironment,
  type SDKRuntimeProfile,
} from '@tanstack/browser-sandbox-experimental'

async function createStartSession(files: Record<string, string>) {
  const runtime: SDKRuntimeProfile = await fetch('/sandbox-runtime-profile.json')
    .then(response => response.json())
  assertSDKRuntimeEnvironment(runtime)

  return new AgentSession(files, {
    assetBaseURL: new URL('/sandbox-runtime/', location.href).href,
    ...runtime.kernelOptions,
    maxBytes: 256 * 1024 * 1024,
    workspace: { maxBytes: 128 * 1024 * 1024 },
  })
}
```

Use workload `vite` for the proven Vite path and `tanstack-start` for the
proven Start path. Start requires a packaged fiber profile, native parser,
cross-origin isolation and `SharedArrayBuffer`. The helper does not silently
fall back to another engine when any of those requirements are missing.

## One complete workspace lifecycle

The blessed owner flow is: create an `AgentSession`, install into its virtual
workspace, spawn the long-running app process, connect its first listening port
to a preview, stop the process, snapshot the files, and restore those files into
a new session. This example uses a small HTTP app so the lifecycle is visible
without framework-specific setup. Replace `files` with a project whose paths are
absolute virtual POSIX paths. The packaged `examples/frameworks/` applies this
same flow to pinned Vite and TanStack Start projects.

In browser code bundled by your host application:

```ts
import {
  AgentSession,
  WorkerHTTP,
  WorkerWebSocket,
  WorkerKernel,
  URLPreview,
  type AgentWorkspaceBinarySnapshot,
} from '@tanstack/browser-sandbox-experimental'

const files = {
  '/project/package.json': JSON.stringify({ private: true }),
  '/project/server.cjs': `
    require('node:http').createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<h1>Hello from the virtual workspace</h1>')
    }).listen(8527)
  `,
}
const options = {
  assetBaseURL: new URL('/sandbox-runtime/', location.href).href,
  timeoutMs: 30_000,
}
let session = new AgentSession(files, options)
let process: Awaited<ReturnType<typeof session.kernel.spawn>> | undefined
let preview: Awaited<ReturnType<typeof URLPreview.mount>> | undefined

function waitForPort() {
  const existing = session.kernel.listeningPorts[0]
  if (existing !== undefined) return Promise.resolve(existing)
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('App did not open a port within 15 seconds'))
    }, 15_000)
    const unsubscribe = session.kernel.subscribePorts(event => {
      if (event.type !== 'open') return
      clearTimeout(timer)
      unsubscribe()
      resolve(event.port)
    })
  })
}

async function start(previewElement: HTMLElement, previewOrigin: string) {
  const portReady = waitForPort()
  process = await session.kernel.spawn('node', ['server.cjs'], {
    cwd: '/project',
    lifetime: 'session',
    timeoutMs: 30_000,
  })
  const running = process
  void (async () => {
    for (let event; (event = await running.next()); ) {
      if (event.type === 'stdout' || event.type === 'stderr') {
        console.log(new TextDecoder().decode(event.bytes))
      }
    }
  })()
  const port = await portReady
  preview = await URLPreview.mount(previewElement, {
    origin: previewOrigin,
    server: new WorkerHTTP(session.kernel, port),
    connectWebSocket: (url, protocols) =>
      WorkerWebSocket.connect(session.kernel, port, previewOrigin, url, protocols),
  })
}

async function stop() {
  preview?.close()
  preview = undefined
  await process?.dispose()
  process = undefined
}

try {
  await session.install({ options: { cwd: '/project', ignoreScripts: true } })
  await session.write({ path: '/project/message.txt', text: 'editable data' })
  await start(document.querySelector('#preview')!, 'https://preview.example.com')

  await stop()
  const saved: AgentWorkspaceBinarySnapshot = await session.snapshot({ encoding: 'binary' })
  await session.close()

  session = new AgentSession({}, options)
  await session.restore({ snapshot: saved })
  await start(document.querySelector('#preview')!, 'https://preview.example.com')
} finally {
  await stop()
  await session.close()
}
```

Use your dedicated preview origin in place of `preview.example.com`; the next
section defines its required hosting policy. Binary snapshots keep file contents
as `Uint8Array` values and are the fast path for IndexedDB, which stores them with
the browser's structured clone algorithm. `session.snapshot()` still defaults to
the JSON-safe base64 shape for tools, JSON files and transport across a text-only
boundary. `session.restore()` accepts both shapes, so existing base64 records keep
working. Restore creates files and installed dependencies in a fresh runtime,
then the owner must spawn the app again. Snapshots do not contain
running processes, open ports, browser state or credentials.

`AgentSession.close()` resolves only after the kernel and its owned compiler
workers acknowledge shutdown. Await it before opening another project so large
WASM compiler reservations do not overlap.

The files are virtual workspace files, not access to the user's device files.
For a runnable edit/run/preview/save/resume implementation, copy
`examples/basic/` from the package into a separate directory and follow its
README. It installs the local SDK tarball and uses only public exports. For
pinned Vite and Start projects, use `examples/frameworks/`. That example adds
dependency installation, source editing, live previews and saved-workspace
resume with the optional compiler worker below.

## Public API map

| Export | Use it for |
| --- | --- |
| `AgentSession` | The recommended file, install, bounded command, resource, snapshot and restore interface for apps and coding agents. `call()` exposes the same operations as JSON-safe tools. |
| `AGENT_TOOL_DEFINITIONS` | JSON schemas for the operations accepted by `AgentSession.call()`. |
| `WorkerKernel` | Lower-level direct worker ownership, process spawning, file sessions, ports and lifecycle control. |
| `HostedKernel` | A `WorkerKernel`-compatible client when the kernel must live in a dedicated cross-origin iframe. |
| `WorkerHTTP`, `WorkerWebSocket`, `URLPreview` | Bridge one virtual listening port to an isolated preview iframe, including Vite HMR traffic. |
| `runShell` | Run one bounded shell script with guest commands routed through the kernel and collect its output. |
| `runMvdanShell` | Lower-level shell parser/executor for hosts that provide their own command routing. |
| `installProjectCommand` | Honor a declared npm, pnpm, yarn or bun install command through the transactional SDK installer. Unsupported package mutations fail clearly. |
| `spawnProjectCommand` | Start a declared long-running command. Package-manager run commands resolve the project's scripts, pre/post hooks and npm lifecycle environment without requiring a package-manager binary in the guest. |
| `SandboxTelemetry` | Keep a bounded in-memory record of SDK lifecycle events. It does not send data. |
| `SDK_COMPATIBILITY` | Feature-detect the experimental public API version before relying on a build. |
| `copyRuntimeAssets` from `/assets` | Verify and copy the immutable runtime into a new host build directory. |

`WorkerKernel` is appropriate when you need process event streams or direct
port ownership. Prefer `AgentSession` for normal project and agent workflows,
because it serializes mutations, bounds captured output and returns JSON-safe
snapshots.

Use the project command helpers when project metadata supplies its own commands:

```ts
import {
  installProjectCommand,
  spawnProjectCommand,
  type WorkerKernel,
} from '@tanstack/browser-sandbox-experimental'

async function startDeclaredProject(kernel: WorkerKernel) {
await installProjectCommand(kernel, 'pnpm install', {
  cwd: '/project',
  ignoreScripts: true,
})

const app = await spawnProjectCommand(kernel, 'pnpm run dev', {
  cwd: '/project',
  writable: true,
  guestWasm: true,
  webAPIs: true,
  lifetime: 'session',
  timeoutMs: 30_000,
})
return app
}
```

`spawnProjectCommand` also runs direct commands such as `node server`
unchanged. `kernel.spawnShell(script, options)` is the lower-level long-lived
shell primitive. The owner remains responsible for draining process events and
disposing the process.

## Errors and unsupported boundaries

Treat error `code` values as the stable machine-readable distinction when one
is present. `ERR_UNSUPPORTED_OPERATION` means the requested Node, installer or
shell behavior is outside this runtime. `ERR_RESOURCE_LIMIT` and more specific
quota codes mean configured or built-in limits stopped the work. `ABORT_ERR`
means the supplied `AbortSignal` cancelled it. Filesystem errors retain familiar
codes such as `ENOENT`, `EACCES` and `EINVAL`. Other errors can describe project,
compiler or browser failures and should be shown with their original message.

Do not retry unsupported operations. A caller may retry a cancelled install,
because its staged changes are discarded. Raise resource limits only after
checking the project is trusted and the browser has enough capacity. There is no
automatic native-addon fallback, remote execution fallback or package rewrite.

`kernel.install(options, signal)` and `session.install({options}, signal)`
accept an optional `AbortSignal`. Cancellation stops the worker installation
and waits for its staged changes to be discarded before rejecting. The original
workspace is preserved, and a later installation can retry normally.
If the worker already completed before cancellation reached it, the successful
result is returned. Cancellation does not undo a completed installation.
Package installation has a 150 second inactivity deadline that renews only
when the installer makes real metadata, download, extraction or lifecycle
progress. A separate five minute absolute deadline never renews. These are
separate from guest command timeouts because a bounded lockfile install can be
slower on Safari or a constrained network. Hitting either deadline closes the
kernel, so create or restore a new session before retrying. Use the optional
`AbortSignal` for an earlier caller-controlled cancellation.

## Optional esbuild worker

Artifacts whose manifest includes `experimentalCompiler` can run the pinned
esbuild-wasm 0.28.2 compiler in a browser worker. Enable it in the owner code:

```ts
import { WorkerKernel } from '@tanstack/browser-sandbox-experimental'

const compilerKernel = new WorkerKernel({}, {
  assetBaseURL: new URL('/sandbox-runtime/', location.href).href,
  maxBytes: 128 * 1024 * 1024,
  experimentalCompiler: {
    maxMemoryPages: 1024,
    timeoutMs: 30000,
    lifetime: 'session',
  },
})

// Use compilerKernel.spawn() for a session-lived development server.
// Close the kernel when the workspace is no longer needed.
compilerKernel.close()
```

This is disabled by default. The installed launcher, wrapper and compiler must
match the pinned bytes; the runtime does not rewrite packages. Plugin callbacks
stay in the guest JavaScript runtime. This option is also accepted by
`AgentSession`.

The page count caps compiler WASM linear memory, not the whole browser worker's
memory. Session mode allows idle time but bounds each protocol request,
including plugin callbacks. Bounded processes retain a whole-workflow deadline.
Esbuild's own watch and serve APIs are unsupported by this backend. Existing
process reservations, file permissions and cancellation still apply.

See [workflow compatibility](COMPATIBILITY.md) for pinned projects and the
limits of each workflow. Historical results do not establish compatibility for
a new build. Use the package's `candidate-compatibility.json` for the exact
artifact, including whether actual Safari was verified separately from
Playwright WebKit.

## Host app previews separately

Runtime assets belong on the owner application's origin. Guest app previews
need a separate origin with no owner-app credentials. Deploy the package's
`preview-host/` directory using its `hosting.json` route and header manifest.
It specifies the `/__sandbox/` files, service-worker scope and secure-context
requirements. Do not serve these routes through your application's HTML fallback.

The host routes and service-worker responses use
`Cross-Origin-Embedder-Policy: require-corp`, including redirects and errors.
This allows previews inside owners that use cross-origin isolation. Keep the
manifest headers when deploying, headers on the static host alone do not apply
to service-worker responses. Bootstrap HTML and workspace navigations also use
`Cross-Origin-Resource-Policy: cross-origin` to permit the separate-origin iframe.
This does not allow foreign-origin workspace fetches. The existing preview CSP only allows same-origin
scripts and connections by default. `URLPreview.mount()` accepts `scriptOrigins`
and `connectOrigins` arrays when an app needs external browser resources. Each
entry must be an exact HTTPS origin, the lists are bounded and the browser still
enforces CORS.

The public `WorkerHTTP` adapter connects to a virtual server port.
`kernel.subscribePorts(callback)` reports `{type: 'open' | 'close', port}` and
returns an unsubscribe function. It immediately replays currently listening
ports. `kernel.listeningPorts` returns a sorted copy of the latest known ports.
Shared listeners report one open and close only when the last listener stops.
Kernel shutdown reports remaining ports closed and removes subscriptions.
Callbacks must handle their own errors, observer exceptions are ignored.
A port event means a TCP listener exists, not that HTTP or hydration succeeded.
`URLPreview.mount()` connects that adapter to the separate preview host.

Preview requests default to a bounded 60 second deadline. First-load framework
compilation can be noticeably slower than warm requests in Firefox, so
`WorkerHTTP` and `URLPreview.mount()` both accept `requestTimeoutMs`. Use the
same value for both. `URLPreview.mount()` also accepts a separate
`startupTimeoutMs` for the full document and inspection handshake. Both values
must be between 10 and 120,000 milliseconds. The preview bridge keeps its own
120 second hard ceiling, and closing the preview still cancels every in-flight
request immediately.
The mount options and cleanup methods are included in the shipped declarations.
This hello-world example does not start a Vite or Start server.

## Threat model and isolation

Treat the owner application, the SDK package and its runtime assets as trusted.
Guest JavaScript runs in a browser worker against a virtual filesystem and only
reaches host features exposed by the SDK broker. Permission checks, memory and
time limits, cancellation, path validation and a separate preview origin reduce
accidental damage and contain ordinary project failures. Guest files do not get
direct access to the user's device filesystem.

This alpha is not a hardened boundary for hostile code. It does not claim
protection from browser or WebAssembly engine vulnerabilities, side channels,
resource exhaustion outside measured limits, dependency attacks or data already
available to the owner or preview origin. A preview can use capabilities allowed
by its CSP and browser permissions. Give each security domain a dedicated
credential-free preview origin, keep owner credentials out of guest files and
snapshots, validate dependency sources, and do not run secrets or adversarial
projects in this alpha.

## License and compatibility limits

Third-party notices and shipped-input records are under `licenses/` and the
runtime directories. This project's source is MIT licensed under the root
`LICENSE`; third-party components retain their own licenses. Local `0.0.0`
candidates remain private and are not published releases. The release build refuses to
produce a public package unless the repository has a regular `LICENSE` file,
an explicit supported SPDX identifier, an explicit alpha version and an explicit
HTTPS source repository URL. Public
artifacts include the exact repository license bytes and bind the same SPDX
identifier and hash in `manifest.json` and `licenses/SHIPPED-INPUTS.json`.
Release builds always include a package description and search keywords.
`SDK_RELEASE_REPOSITORY_URL` is required. Homepage and issue URLs are optional,
set through `SDK_RELEASE_HOMEPAGE_URL` and `SDK_RELEASE_BUGS_URL`. The builder
never guesses these URLs from a local checkout. URL validation checks the
metadata format, not whether the source has actually been published.

Native addons, arbitrary native executables and complete Node compatibility are
not supported guarantees. Keep permission checks, resource limits and deadlines
enabled. Verify your app and the exact artifact in each target browser before
adopting it. Do not put sensitive projects or credentials in this experiment.
