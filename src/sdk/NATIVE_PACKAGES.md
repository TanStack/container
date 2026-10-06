# Native browser sandbox SDK

Experimental, not yet released. API 8 uses the native runtime at both the package
root and `/native`. It does not include a QuickJS kernel or an implicit runtime.
Each package pair needs its own browser acceptance before use, older private
candidate results are not evidence for a new release.

## Prepare browser assets

The SDK depends on its exact-version runtime package and pinned upstream
compiler packages. Run setup explicitly in your app's build, no postinstall
hook or setup download is required:

```js
import {
  prepareRuntimeAssets,
  readNativeRuntimeCandidates,
  createNativeOwnerHostAssets,
} from '@tanstack/browser-sandbox-experimental/assets'

// public must exist. sandbox must not already exist, including as a symlink.
const assets = await prepareRuntimeAssets('public/sandbox')
const runtimeCandidates = readNativeRuntimeCandidates('/sandbox/runtime/')
const owner = createNativeOwnerHostAssets({
  parentOrigin: 'https://example.com',
  previewOrigin: 'https://preview.example.com',
  workerPath: runtimeCandidates[0].workerURL,
  assetBaseURL: '/sandbox/runtime/',
  runtimeCandidates,
})
```

Setup verifies package inventories, copies pinned compiler WASM from installed
dependencies and writes a deployment manifest. It refuses modified inputs and
existing output. Failed setup can leave partial output for inspection, it does
not remove files. Use a fresh output directory for each build.

Serve the generated `owner.files` with `owner.headers` on a separate trusted
owner origin. Serve the SDK's `index.js` and its sibling `native-chunks`
directory there too, preserving relative paths. Serve the prepared runtime at
`/sandbox/runtime/`. The catalog supplies versioned worker paths, do not assume
there is a flat `native/engine.js`.

Serve the preview assets on their own origin using the prepared
`preview-host/hosting.json` contract. Site, owner and preview must have distinct
origins. HTTPS is required except for local loopback development. These helpers
return files and headers, they do not start a server, deploy files or configure
your hosting provider. Give every active workspace its own preview origin.

## Connect and start

After the owner iframe loads:

```js
import {
  NativeOwnerClient,
  URLPreview,
} from '@tanstack/browser-sandbox-experimental'

const client = await NativeOwnerClient.connect(
  ownerFrame.contentWindow,
  'https://owner.example.com',
  'https://preview.example.com',
)
await client.start(files, {
  installCommand: 'npm install',
  startCommand: 'npm run dev',
})
const preview = await URLPreview.mount(previewElement, {
  origin: 'https://preview.example.com',
  server: {
    fetch: request => client.fetch(request),
    revision: () => client.workspaceRevision(),
  },
  connectWebSocket: (url, protocols) => client.connectWebSocket(
    'https://preview.example.com', url, protocols,
  ),
})
```

Project files include `package.json`. Matching npm v2/v3 lockfiles are supported,
otherwise a bounded npm registry resolver prepares a lock. Declared install
commands are validated, they do not run a host package manager. Unsupported
scripts or compiler versions fail explicitly. This is browser Node API
compatibility, not a native Node binary, OS container or full Node guarantee.

The native installer does not yet support npm workspace links or local `file:`
dependency links. Both startup and live installation reject them explicitly.

The owner supports files, snapshots, checkpoints, restart, guest HTTP streaming,
WebSockets, terminal commands and live output. Project HTTP request bodies are
currently buffered. Subscribe to events for startup and guest logs. Dispose the
owner before removing its iframe. The native owner is a separate-origin
execution boundary, not permission to expose credentials or sensitive projects.

## Locked package URLs

The installer accepts npm registry archives by default. To use another HTTPS
package host, configure its exact origin when creating the owner assets:

```js
const owner = createNativeOwnerHostAssets({
  parentOrigin: 'https://app.example',
  previewOrigin: 'https://preview.example',
  runtimeCandidates: readNativeRuntimeCandidates(),
  packageDownloadPolicy: {additionalOrigins: ['https://packages.example']},
})
```

Supply a normal npm lockfile with resolved package URLs and SHA-512 integrity.
Generate it with npm before mounting the project. URL dependencies without a
lockfile are not supported yet. Downloads omit credentials and do not follow
redirects. The owner host captures this configuration, projects cannot expand
it through `NativeOwnerClient.start`, a file edit or a terminal install. This
controls the installer, it does not turn browser-native execution into a
security boundary for arbitrary untrusted code.

## Terminal

Open one shell session per terminal pane. It keeps the working directory,
variables and shell functions between commands. Run one foreground command at
a time. Here, `terminal` is your display, such as an xterm instance:

```js
const shell = await client.openTerminalSession('/project')
try {
  const command = shell.runCommand(
    'cat',
    text => terminal.write(text),
    { columns: 80, rows: 24 },
  )
  command.writeInput('hello\n')
  command.endInput()
  const result = await command.result
  console.log(result.exitCode, result.cwd)
} finally {
  await shell.dispose()
}
```

Wire terminal input to `command.writeInput`, Ctrl-D to `command.endInput`,
Ctrl-C to `command.interrupt`, and size changes to `command.resize(columns, rows)`.
Output callbacks receive text and a `stdout` or `stderr` stream name. Await
`command.result` before starting the next command. Dispose the shell when its
pane closes. The host supplies the prompt, line editing and command history.

For a single command without persistent shell state, use
`client.openTerminalCommand(line, cwd, onOutput)`. Its control also provides
`writeInputAcknowledged` for streamed input with backpressure. Input chunks
must be nonempty and at most 64 KiB. `client.terminalCommand` is the simpler
output-only command API.

These commands share the preview's files and installed JavaScript packages.
They are browser-hosted shell and Node-compatible commands, not an OS terminal
or a full PTY. Native executables and unsupported interpreters do not run.

## Agent tools

An agent session requires an explicit backend, it never chooses a runtime:

```js
import {
  AgentSession,
  NativeAgentBackend,
} from '@tanstack/browser-sandbox-experimental'

const agent = new AgentSession(new NativeAgentBackend(client), {
  maxOutputBytes: 1024 * 1024,
})
await agent.read({ path: '/app/package.json' })
await agent.run({ command: 'node', args: ['script.js'], cwd: '/app' })
await agent.close()
```

Closing the session also disposes its owner. The old files/options constructor,
`WorkerKernel`, `HostedKernel` and legacy runtime URLs are not part of this
native package. `/assets` remains a Node-only build entry, not a browser import.

Publication still requires complete notices, distribution review, a fresh
source-bound build and browser acceptance of those exact artifacts. WebKit
results do not prove actual Safari support. The full new SolidJS example suite
and production adoption remain separate checks.
