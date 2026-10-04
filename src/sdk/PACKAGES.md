# Browser sandbox SDK

This guide describes the historical mixed native/QuickJS private package.
The default API 8 build is native-only, use the
[native package guide](NATIVE_PACKAGES.md) for its setup and API.

Experimental and unpublished. Private split-package candidates have passed
repeated Chromium and Firefox workflows. Each release package pair still needs
its own acceptance, including the current source-bound alpha candidate. Actual
Safari remains unverified. Do not transfer results between package candidates.

The browser SDK depends on a matching runtime-support package. Upstream compiler
packages are ordinary pinned npm dependencies, not copied WASM files in our npm
tarballs. Our custom engines and browser workers remain in runtime support.

There are two separate steps:

- npm installs the upstream compiler packages as dependencies.
- Your app's build prepares worker scripts and WASM at URLs the browser can load.

The second step creates deployment assets, not another copy inside our SDK
package. Browsers cannot load files directly from your installed node_modules.

## Prepare assets

After installing the SDK, run this explicitly in your application's build or
setup step. There is no postinstall hook and setup does not download packages.

```js
import { prepareRuntimeAssets } from '@tanstack/browser-sandbox-experimental/assets'

// public must already exist. sandbox must not exist, including as a symlink.
const assets = await prepareRuntimeAssets('public/sandbox')
console.log(assets.runtimeDirectory)
```

Setup bundles the installed compiler adapters for browser workers, copies their
WASM unchanged, preserves available notices, and writes a deployment manifest
with hashes. It refuses mismatched pinned inputs or existing output. Failed
setup can leave partial output for inspection, it never deletes existing files.
Use a fresh build output directory for each build.

Pass the hosted runtime URL explicitly:

```js
import { WorkerKernel } from '@tanstack/browser-sandbox-experimental'

const kernel = new WorkerKernel({}, {
  assetBaseURL: new URL('/sandbox/runtime/', location.origin).href,
})
```

For the browser-native Vite path, use the same prepared assets with
`NativeDevServer` from `@tanstack/browser-sandbox-experimental/native`.
The native entry does not import the QuickJS kernel or its default worker.
Read `readNativeRuntimeCandidates('/sandbox/runtime/')`
from the Node-only assets entry in your build step, then serialize that catalog
into your browser configuration. Pass it as `runtimeCandidates` and use its
first `workerURL` for the required `workerURL` option. Set `assetBaseURL` to
`/sandbox/runtime/`. The catalog supplies versioned worker paths, do not assume
there is a flat `native/engine.js` file. For a project without a resolved npm
lock, call `prepareNativeRuntime(files, runtimeCandidates)` with `/app`-prefixed
file paths before constructing the server and use its returned files and lock,
or use the owner setup below, which handles preparation.
This is a general SDK entry, but the
current native package is a private candidate, not a publishable release.
Its shipped-dependency notice review must be completed before publication.

Native agent tools require an already connected and started `NativeOwnerClient`:

```js
import {
  AgentSession,
  NativeAgentBackend,
} from '@tanstack/browser-sandbox-experimental/native'

const agent = new AgentSession(new NativeAgentBackend(client), {
  maxOutputBytes: 1024 * 1024,
})
await agent.read({ path: '/app/package.json' })
await agent.close()
```

Closing this agent also disposes its owner. The root entry still accepts
`new AgentSession(files, options)` and defaults to the legacy kernel. The native
entry accepts `new AgentSession(backend, options)`, it never picks a runtime for
you. The current package build still includes legacy runtime assets, even when
your browser imports only the native entry.

When project files include `package.json` and a matching npm v2 or v3
`package-lock.json`, the worker can plan and install dependencies directly.
With a declared install command and no lockfile, the worker can resolve a
bounded npm v3 lock from registry metadata in the browser and save it after
installation. The resolver also inspects verified package archives for bundled
dependencies. A freshly installed split package has passed the no-lock
development gate for all four selected TanStack examples in Chromium, Firefox,
and WebKit. The resolver now retries transient metadata failures at most twice,
and the freshly rebuilt package repeated this complete development gate. An
earlier attempt had a failed npm registry metadata fetch, so sustained network
failure behavior remains unproven. You can still pass a preplanned `lock`
explicitly. Native project loading does not yet parse `pnpm-lock.yaml` or
install workspace links.
Hosts can pass `installCommand` and `startCommand` as declared package-manager
commands, for example `pnpm install` and `pnpm run dev`. The first validates
the install request and uses an npm lock or the bounded npm registry resolver;
it does not run pnpm's resolver. The second resolves a `package.json` script
and runs only the dev commands supported by the native runtime. Unsupported
commands fail explicitly.
`workspaceRoot` lets a host mount paths such as `/project/package.json` and
use that same prefix for reads, writes, and snapshots. The worker still runs
the project at `/app`; project source that embeds absolute `/project` paths
is not rewritten. Use relative project paths for portable projects.
For projects with more than one listening service, `fetch(request)` uses an
explicit URL port when it belongs to the project. `previewServer(port)` can
bind a preview to one specific service.
`waitForHTTPReady({port, path, timeoutMs})` checks that a project service can
answer HTTP before a host attaches its preview. It refreshes the project's
owned ports while waiting for an auxiliary service. It returns the ready port;
an HTTP 5xx response or transport error is retried until the timeout.
When `URLPreview` uses `NativeDevServer.previewServer(port)`, it remembers the
workspace revision of each loaded document. If an SDK file edit finishes
before that document's live-update WebSocket connects, the preview reloads
once after the connection opens so the edit is not missed. This tracks SDK
file writes and completed terminal commands with changed files, not arbitrary
out-of-band file mutations.
For an owner iframe, pass `server: { fetch: request => client.fetch(request),
revision: () => client.workspaceRevision() }` to `URLPreview.mount()` for the
same recovery. The revision comes from the owner, so edits from other owner
clients are visible too.
`subscribeEvents(listener)` streams startup progress, guest stdout and stderr,
and diagnostics to the host. The bounded `events` array keeps recent events
for inspection; unsubscribe when the host no longer needs live updates.
For a separate execution origin, serve a trusted owner iframe on a dedicated
hostname and call `installNativeOwnerHost({allowedParentOrigin, workerURL})`
inside it. The host can call `NativeOwnerClient.connect(frame.contentWindow,
ownerOrigin)` after the frame loads. For a declared script that listens on a
non-default port, pass `previewPort` in `start()` or `restoreCheckpoint()`.
Each simultaneously active workspace needs its own preview origin. Sharing a
preview origin makes the service worker see more than one request bridge, and
it rejects those requests rather than routing them to the wrong workspace.
For local development, an owner configured with `previewHostSuffix: '.localhost'`
can accept a different `<workspace>.localhost` preview hostname per client,
on the configured preview protocol and port. Pass that exact origin to
`NativeOwnerClient.connect(frame.contentWindow, ownerOrigin, previewOrigin)`
and `URLPreview.mount()`. A fixed preview origin remains the default. Dynamic
preview origins have passed same-browser-context TanStack.com tests in
Chromium and WebKit. Firefox shows the preview but pointer input fails in a
cross-origin-isolated parent; the same failure reproduces with a tiny SDK
preview, so Firefox multi-workspace interaction remains unsupported.
The Node-only `createNativeOwnerHostAssets({parentOrigin, previewOrigin})`
export from `@tanstack/browser-sandbox-experimental/assets` returns
`/owner.html` and `/__sandbox/owner.js` plus their response headers. Serve
them on the owner origin alongside `/sdk/index.js` and the prepared runtime
directory, including the versioned worker paths from its catalog. Pass the
catalog and a worker path explicitly, as shown below. The generated page uses
an external script, checks
that the owner origin differs from the site and preview origins, and accepts
only exact HTTPS origins (HTTP loopback is allowed for local development).
It does not create a host, deploy files, or configure the separate preview
origin. Serve preview assets using the supplied preview `hosting.json`.

For a package with multiple compiler runtimes, read its catalog in the same
build step and pass it to the owner setup. The runtime path must match where
you serve the prepared assets:

```js
import {
  createNativeOwnerHostAssets,
  readNativeRuntimeCandidates,
} from '@tanstack/browser-sandbox-experimental/assets'

const runtimeCandidates = readNativeRuntimeCandidates('/sandbox/runtime/')
const owner = createNativeOwnerHostAssets({
  parentOrigin: 'https://example.com',
  previewOrigin: 'https://preview.example.com',
  workerPath: runtimeCandidates[0].workerURL,
  assetBaseURL: '/sandbox/runtime/',
  runtimeCandidates,
})
```

The project selects its compiler from locked or resolved package versions.
If no runtime matches, startup fails explicitly, it does not change the
project's dependencies or select a different compiler version.
The channel supports start, in-memory restart, restore,
file reads and edits, workspace snapshots, checkpoints, ports, live events,
pull-based HTTP response streaming, guest WebSockets, and disposal. The owner checks the exact
parent origin and keeps the worker
and checkpoint storage on its own origin. Always await `dispose()` before
`close()` or removing the frame. Pass `previewOrigin` to the owner host to
enable WebSockets, then use `NativeOwnerClient.fetch()` and
`NativeOwnerClient.connectWebSocket()` with `URLPreview.mount()`. HTTP request
bodies are currently buffered. A fresh installed private SDK/runtime pair
passed the owner-origin development test with four selected TanStack examples
and a supplementary Solid Start counter in Chromium, Firefox, and WebKit.
Each used its npm lock, SSR, preview, and a live edit. The streaming example
also exercised both server-function stream interactions. The TanStack Start
counter additionally ran its declared production build and restored the
edited workspace into a production worker in all three engines. TanStack Start
basic passed the same owner production flow with deferred-route navigation
after the SDK began discovering HTTP ports opened after worker startup. The
Router file-based SSR example passed its declared client and server build,
checkpoint restore, and production Posts navigation in the same three engines.
The supplementary Solid Start counter passed its declared production build,
checkpoint restore, and hydrated click in those engines too. The streaming
Start example's declared build currently fails TypeScript
TS18046 in its own `src/router.tsx`, which reproduces with ordinary Node and
the same lockfile. A labeled Vite-only diagnostic, which does not count as a
declared-build pass, did run its production preview and both server-function
streams in all three engines. Explicit guest-loopback WebSockets reach their
owned port, including Vite HMR on a different port from the preview HTTP
server. Streaming production has not passed its declared build, and the actual
new SolidJS site examples remain untested.
The same installed private pair then passed two consecutive combined owner
runs across all five known examples and Chromium, Firefox, and WebKit. Those
runs used the labeled Vite-only production diagnostic for streaming, not its
failing declared `tsc --noEmit` step. They are repeatability evidence for this
package candidate, not a release or site-switch approval.
Separate ports on one hostname do not isolate cookies. Use a dedicated owner
hostname with no host credentials and review the deployment's CORS, CSP,
cookie, and frame policies before running untrusted projects.
When replacing a running project worker, await `NativeDevServer.dispose()` so
its server, sockets, and compiler services close before starting the next
worker. `close()` remains an immediate cancellation path.
`snapshot()` returns a file-only map. `snapshotWorkspace()` also reports
directories, symlinks, and permission modes using the host's `workspaceRoot`.
`saveCheckpoint(key)` persists the full workspace snapshot in IndexedDB using
the SDK's chunked checkpoint store. After disposing the old worker,
`NativeDevServer.restoreCheckpoint(key, options)` creates a fresh worker from
that snapshot and skips dependency installation. This saves file contents,
including installed packages, across page reloads and browser restarts in the
same browser profile, including empty directories, symlinks, and permission
modes. It does not preserve live process state. Browser storage
quota and eviction still apply.
For an in-memory restart without IndexedDB, call
`await server.restart(options)` and use the returned `NativeDevServer` instance.
The original instance is disposed after its workspace snapshot is captured.
`NativeOwnerClient.restart()` snapshots the running workspace in memory,
replaces the project worker, and starts the same declared entry or script
without reinstalling dependencies. It preserves files and installed packages,
not live process state or active preview sockets. Reload the preview after a
restart. `NativeOwnerClient.terminalCommand(line, cwd)` runs browser-hosted
shell syntax against that same worker workspace and returns stdout, stderr,
exit status, the next working directory, and changed paths. Its optional third
argument receives output chunks while shell commands or supported build steps
run. The shell supports pipes, redirection, variables, `pwd`, `cd`, `echo`, and `printf`.
Its current external programs are `ls`, `cat`, `mkdir`, `touch`, `cp`, `mv`,
`rm`, `sleep`, `stty size`, `node <script> [args...]`, `node -e <source>`,
`node - [args...]` for JavaScript on stdin, and `help`. Node scripts run in
an isolated worker with live workspace file reads and writes, stdin, stdout,
stderr, and interruptible execution. Referenced timers and virtual sockets keep
a foreground Node command alive until they close or the command is interrupted.
Declared `npm`, `pnpm`, `yarn`, and `bun` run scripts execute through the same
live shell, including nested scripts, arguments after `--`, stdin, output,
and interruption. Supported Vite build and typecheck scripts still use the
runtime's compiler path. An installed Vite `dev` or `serve` command uses the
browser-workspace Vite adapter, remains a foreground job, and releases its
virtual port when interrupted. Installed JavaScript package binaries are resolved
through each package's `node_modules/.bin` links and run in isolated Node
command workers. Node-shebang scripts work; binaries that need another
interpreter or native machine code do not. The installed Prettier CLI has
passed `--version` and `--write` against a workspace file in Chromium,
Firefox, and WebKit.
At the project root, the separate-origin owner terminal also accepts a
standalone `npm install`, `pnpm install`, `yarn install`, or `bun install`
command. It snapshots the workspace, starts a replacement worker, resolves an
outdated lockfile when needed, and switches to the new preview only after the
replacement is ready. A failed or interrupted install leaves the old worker
running. Editor writes received while an install runs are applied after it
finishes. This is the browser package installer, not a host package-manager
process, and shell-composed install commands are not supported yet.
For a foreground command that
needs stdin, use `const session = client.openTerminalCommand('cat')`, then
`session.writeInput('hello\n')`, `session.endInput()`, and
`await session.result`. `session.resize(columns, rows)` updates the child
process's terminal dimensions, and `session.interrupt()` stops the command. Each session
owns its input channel and closes it when the command settles. This is not
yet a general process terminal: native package binaries and full PTY
behavior remain open. Nested workers allocate virtual listener ports through
the parent kernel, including port `0`, and report explicit port collisions as
`EADDRINUSE`. An optional AbortSignal as the fourth
argument interrupts an ordinary shell command without stopping the preview
server. The supported Vite build command can also be interrupted.
For an immediate terminal size on a one-off command, pass
`{columns, rows}` as the fifth argument to `openTerminalCommand`. A later
`session.resize(columns, rows)` changes the size while it runs.
For a persistent interactive shell, use `await client.openTerminalSession()`
and call `session.runCommand(line, onOutput, {columns, rows})`. The third
argument applies the current terminal size before the command starts, so an
immediate `stty size` observes it. While a command is running, its returned
control supports `writeInput`, `endInput`, `resize`, and `interrupt`; await
`control.result` for the exit code and next working directory. Call
`await session.dispose()` when the terminal closes. Separate commands keep
shell variables, functions, and working directory until the session is disposed.
`runBuildScript('build')` runs supported package scripts in the worker. It
currently handles sequential `vite build`, `vite build --ssr`,
`tsc --noEmit`, and nested `npm run` or `pnpm run` steps. Unsupported commands
fail before any build step runs. The TypeScript step uses the project's
installed compiler and reports its real diagnostics; it does not treat a
successful Vite build as a successful type check.

Host the generated kernel host and runtime on the trusted owner origin. Deploy
the generated `preview-host` directory on a separate preview origin, following
its `hosting.json` routes and headers. Asset setup does not configure your host
or weaken the preview isolation requirements. See `COMPATIBILITY.md` for runtime
limits, but its older artifact results do not verify these new packages.

The old synchronous `copyRuntimeAssets` helper is replaced by asynchronous
`prepareRuntimeAssets`. Moving compiler code out of the npm tarball does not
remove the need to preserve notices in the browser deployment.

## Run the packaged examples

Copy either example directory out of the installed SDK package into your own
project directory. While the SDK is unpublished, install matching local core
and runtime tarballs in that copied directory, then run `npm start`. Each guide
includes the install command and the host prints the URL to open:

- [Basic workspace](examples/basic/README.md): edit a file, run a small
  Node-style app and view its output and preview. Save, reload the page, resume
  and run again. This does not load Vite or TanStack Start.
- [Vite and TanStack Start](examples/frameworks/README.md): install the pinned
  project dependencies, run an app, apply live edits and try its interactions.
  Save, reload and resume the saved workspace without reinstalling dependencies.

Both examples use the public SDK API. Their host serves files and prepares
assets; guest app execution happens in the browser. Keep the same owner origin
when resuming saved work. See [workflow compatibility](COMPATIBILITY.md) for
tested workflows and limits, including what offline resume does and does not
preserve.

## Isolation limits

The owner application, SDK and runtime assets are trusted. Guest code runs in
workers against a virtual filesystem, with host access mediated by the SDK.
It does not get direct access to the user's device filesystem. Preview content
must run on a separate, credential-free origin with the supplied hosting policy.

This alpha is not a hardened boundary for hostile code. It does not protect
against browser or WebAssembly vulnerabilities, dependency attacks or all forms
of resource exhaustion. Preview content can use capabilities allowed by its CSP
and browser permissions. Do not put owner credentials into guest files or run
adversarial projects in this alpha.

Snapshots include saved workspace files without filtering secrets, including
`.env` files. They do not capture running processes, open ports or host browser
state. Keep snapshot exports private if the workspace contains sensitive data.
