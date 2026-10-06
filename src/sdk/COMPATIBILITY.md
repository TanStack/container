# Workflow compatibility

Native terminal assets use the host's `assetBaseURL`, a same-origin HTTP
directory with no query or fragment. It defaults to `/runtime/`, independently
of `workerURL`, so flat engine URLs remain supported. Set it explicitly when
mounting runtime assets elsewhere, for example `/sdk/runtime/`. Owner frames
configure it in `installNativeOwnerHost` or `createNativeOwnerHostAssets`,
project startup options cannot override the owner's asset directory.

`NativeDevServer` accepts `runtimeCandidates`, each with a hosted `workerURL`
and exact `toolchain: { vite, rolldown }` versions. It selects one candidate
from an explicit runtime lock, npm shrinkwrap/package-lock, or mounted compiler manifests.
Shrinkwrap takes precedence over package-lock, matching project installation.
With installation disabled, mounted versions take precedence over stale locks.
Missing versions, no match, or multiple matches reject before worker startup.
The selected URL must remain on the application origin. `workerURL` remains
the normal single-runtime option when candidates are not supplied.

This selects among assets the host already provides. It does not download or
build new compiler versions, select from unresolved package.json ranges, or
weaken the worker's exact compiler compatibility checks. Hosts must supply
truthful candidate metadata from their built runtime toolchain inventory.

For owner frames, configure `runtimeCandidates` in `installNativeOwnerHost`
or `createNativeOwnerHostAssets`. Candidate URLs must belong to the owner
origin. The owner's configured catalog is used for start and restore, project
options do not override it. Current source prepares lockless owner starts
against that catalog before creating the worker, using a cancellable startup
reservation. The `yFvsie` SDK passes a real registry lockless project through
separate host and owner origins in Chromium, Firefox and WebKit, including a
custom `/project` root and fetch-entry response. That check does not establish
arbitrary compiler-version or full framework support on this artifact.

For explicit pre-start resolution, `prepareNativeRuntime(files, candidates,
{ signal })` accepts a canonical `/app` file map. Without a lock or mounted
compiler manifests, it uses the existing full dependency resolver and returns
`{ files, lock, candidate }`. Pass these returned files and lock to
`NativeDevServer`, using `candidate.workerURL`. It preserves the input map,
shrinkwrap precedence and exact candidate matching. It does not download or
build missing compiler runtimes. Direct constructor startup is unchanged.
The `fzz77I` SDK passes real registry resolution, installation and
fetch-entry serving in Chromium, Firefox and WebKit with identical generated
lock bytes through startup. Those checks do not establish arbitrary version
support or full framework acceptance on this SDK.

This is experimental software with bounded, artifact-specific results. Each
split package contains `package-assets.json`, which records its own file bytes
and hashes. Explicit asset setup writes `deployment-manifest.json`, binding the
prepared browser files to the runtime package manifest. These inventories prove
file identity, not that an application works.

Browser acceptance is separate evidence bound to both package manifest hashes,
both npm tarball hashes and the prepared deployment hash. Split packages do not
ship the legacy `manifest.json`, `candidate-compatibility.json` or
`release-record.json`. Do not look for those files to determine split-package
support, and do not transfer passing results between different package pairs.

## Type checking in current native source

The native build API and `tsc --noEmit` command path use the project's installed
`typescript` JavaScript API against its mounted files. The `@typescript/typescript6`
npm alias is accepted and its standard libraries come from its declared
dependency. If the installed `tsc` entry points to `@typescript/native`, the
command worker routes that narrow command to the same JavaScript checker.
This does not execute the TypeScript 7 native binary or establish identical
compiler semantics. Other native compiler commands and flags are not covered
by that adapter. A successful declared-script API build is not proof of native
TypeScript 7 CLI compatibility.

## Development child processes

The current development runtime has additional child-process support that is
not included in the frozen candidate below. Its browser checks are bound to
the `ipc-delayed-listener` runtime and matching `6ssXEX` SDK build, not to a
published package. See `reports/native-child-ipc-disconnect-2026-09-30.md` for
the retained results.

That development build supports Node script, eval and stdin child commands;
fork IPC; `execFile` output capture; pipe and ignore stdio; binary input and
output; cancellation and timeouts. Parent and child IPC disconnect update
connection state, queued startup messages arrive before disconnect, and an
open channel preserves messages for delayed listeners. Fifteen shared
Node/browser cases and the existing fork/MessageChannel workflow pass in
Chromium, Firefox and Playwright WebKit. Those checks do not prove complete
Node or IPC compatibility.

Custom file descriptors, extra stdio slots, arbitrary OS
executables, native addons, shell `exec`, synchronous child commands and
signals other than SIGTERM/SIGKILL remain unsupported. The Node executable
path is virtual, this is browser execution, not an OS process.

The later `inherited-output` runtime and matching `c9BSQI` SDK support stdout
and stderr inheritance in a stdio array, for example
`['ignore', 'inherit', 'inherit']`. Inherited child stream handles are null,
binary output goes to the parent process streams, and writes wait for parent
completion. Twenty-four shared Node/browser cases pass in all three engines,
including1MiB per inherited output with paused receivers and every byte checked.
Inherited stdin and blanket `stdio: 'inherit'` remain unsupported. See
`reports/native-inherited-child-output-2026-10-01.md` for artifact-bound
evidence and warning details. This does not update the frozen candidate.

The later `preload-sequence` development runtime and matching `6AjEdI` SDK
also support `--import` and `--import=` ESM preloads. Twenty-two shared
Node/browser cases pass across the same three engines. CommonJS preloads run
first, ESM preloads run sequentially, initialization finishes before the entry,
and duplicate imports use the module cache. Forks inherit preload flags and
initialize them in the child. Unresolved preloads end without
running the entry and preserve an explicit exit code. Thrown or missing
preloads fail. See `reports/native-import-preloads-2026-09-30.md` for evidence
and the limits of those checks. These results do not update the frozen package
candidate below.

## Verified split candidate

Source-bound candidate `JIhQsM`, version `0.1.0-alpha.0`, passes twelve strict
workflows: three Vite and three Start cold/save/offline-resume cycles in each of
Chromium and Firefox, with no retries. The audit verifies byte-exact workspace
restoration, blocked external dependency requests during resume, further edits
and interactions, acknowledged shutdown and resource cleanup. All twelve
prepared deployments match the adoption check's deployment bytes.

| Artifact | SHA-256 |
| --- | --- |
| SDK package manifest | `caafa72a28ec76aaf7396848cadadce1ab489993bdd67f83447a0ffd93295e09` |
| Runtime package manifest | `02ffb4ab94c67fab1bb0df20a231c422e0eaa087a7714fea69d06dcbd1275aa5` |
| SDK npm tarball | `7d2f036e70f281ed7516eb49814e2035ca4c0de48b1505c436467fefd1e9d14d` |
| Runtime npm tarball | `69fb066ba08bbbf41f7d341eb58e3267faf1b9697264ffdf7680382274015b6b` |
| Prepared deployment manifest | `8cec6912bb9c671b0be45861ed4d2e6db6d4d9b0f0d974cf97a1ef3dbb6c5ed3` |
| Source archive | `2bc2c13215115abfb7adbfcc74105f92cebffbe354e3165ddeec1d1d384467c1` |

Actual Safari acceptance remains unverified. This is not release approval,
publication or production TanStack.com integration evidence. This document is
a summary, not the external audit itself; the retained audit is named
`sdk-split-JIhQsM-strict-audit.json` and is not shipped inside the SDK. Editing
this guide does not change the frozen candidate or accept a later rebuild.

The strict Vite workflow covers a pinned Vite 7 app with registry installation,
negative and positive tests, interactive preview, state-preserving HMR, save,
owner reload and byte-exact offline resume. The strict Start workflow covers a
pinned TanStack Start fixture with SSR, hydration, a POST server function,
navigation, route live edit, save, owner reload and offline resume. These are
representative workflows, not claims that every Vite plugin, Start feature or
Node package works. Playwright WebKit evidence never substitutes for actual
Safari evidence. Phones are outside the alpha requirements.

## Project and runtime boundaries

`examples/frameworks/projects.json` ships complete pinned locks. Both packaged
examples use Vite 7.3.6, Rollup WASM 4.63.1 and esbuild WASM 0.28.2. The Start
example uses `@tanstack/react-start` 1.168.25 and Lightning CSS WASM 1.33.0.
The separate real Start/Vite 8 counter test is not that packaged example.
Installed dependencies alone do not establish that their APIs or CLI work.

The strict JIhQsM runs are separate consumers, not execution of the packaged
example UI. Their Vite fixture is `fixtures/install-vitest`, pinned to Vite
7.3.6 with the same Rollup/esbuild WASM overrides. Although its lock includes
Vitest 3.2.7, the workflow runs `node check.mjs`, not Vitest. The strict Start
consumer combines `fixtures/install-start-wasm` with `fixtures/start-basic`
app source: Start 1.168.25, Router 1.170.15, React 19.1.1, Vite 7.3.6 and the
same Rollup/esbuild/Lightning CSS WASM versions listed above. Public example
results must be recorded separately; these strict passes do not imply that
every test runner, framework feature or dependency version works.

The shipped JIhQsM basic example separately passes edit, run, preview, save,
reload and resume in Chromium and Firefox. The packaged framework UI passes
Vite in both browsers and Start in Chromium, including offline dependency
resume and restarting its host on the same origins. Packaged Start in Firefox
currently fails cold hydration: SSR renders, but the hydration marker remains
false for the unchanged 60-second assertion. These results do not establish
complete packaged-framework acceptance. The separate TanStack.com Vite 8
Basic example also has an unresolved Firefox Nitro startup timeout.

The framework example explicitly enables the compiler worker and selects the
engine matching the artifact's build profile. Fiber profiles require
cross-origin isolation. See the example README for hosting and memory limits.
There is no automatic substitution of unsupported native packages.

The public project-command helpers translate declared npm, pnpm, yarn and bun
install/run commands onto the SDK installer and shell. Package run commands
honor pre/post hooks and npm lifecycle environment variables without claiming
that a package-manager binary exists in the guest. The framework example
uses these names as command aliases, not implementations of each package manager.
Installation reads npm v2/v3 `package-lock.json` or `npm-shrinkwrap.json`, not
pnpm, yarn or bun lockfiles. Without an npm lockfile it resolves a bounded
dependency tree from registry metadata. `ci` is also an installer alias, not
full npm CI behavior. `--offline`, `--prefer-offline` and `--frozen-lockfile`
are rejected rather than silently ignored. Restoring an already installed
workspace offline is a separate save/resume capability. The framework example
installs with `ignoreScripts: true`, disabling install lifecycle scripts. Its
test scripts are small workflow checks, not proof of
complete Vitest compatibility. Long-running app processes use preview controls,
not the example's bounded script runner.

Native live installation is available through interactive sessions and
one-shot terminal commands. It stages the package tree, updates the selected
npm lockfile, and refreshes a running Vite or fetch-entry app. Fetch-entry
refresh validates the replacement before publishing it on the existing port.
Browser checks cover failed entry evaluation, invalid fetch exports, package
and lockfile rollback, successful retry, and an open response stream surviving
replacement in Chromium, Firefox and Playwright WebKit. See
`reports/native-fetch-refresh-2026-10-01.md` for tested artifacts. These checks
do not establish rollback of arbitrary entry side effects, old requests using
dynamic imports during replacement, or actual Safari support.

Snapshots preserve workspace files, installed dependencies and saved app data,
not running processes, in-memory state or browser sessions. Resume starts a
fresh runtime. Offline dependency resume still needs the host and runtime
assets; it does not mean offline hosting. Browser storage can be evicted.

Native addons, arbitrary native binaries and complete Node compatibility are
not supported. The compiler backend does not support esbuild watch/serve.
Keep existing permissions and resource limits enabled. This experiment is not
a production security boundary for arbitrary hostile projects, and should not
contain sensitive projects or credentials.

## Current private native package candidate

The browser-native runtime executes project JavaScript in the browser's native
engine, with a worker-owned filesystem and Vite toolchain. A private SDK and
runtime tarball were installed into a fresh npm consumer and their deployment
assets were assembled from the installed runtime package. The four pinned
TanStack examples and a supplementary Solid Start counter passed development
and interactive production checks in Chromium, Firefox, and WebKit in two
consecutive full 30-cell runs for one private SDK candidate. A later SDK
candidate with general multi-port routing also passed two full 30-cell runs
and a separate HTTP/WebSocket two-port test on all three engines. The reports
are recorded in the source repository's `NATIVE_GOAL.md`, not bundled into
the package.

The supplementary counter is not the new SolidJS site suite, and these checks
do not establish direct site integration or release approval.

The current source-built SDK also passes the real TanStack streaming example
in development and production on all three engines with stronger delivery
checks. Both streaming buttons show between one and nine results before all
ten complete. Timing logs record the first visible result and completion;
these are fixture measurements, not general performance guarantees.

The later `upload-cancel` development runtime and `qtTNgy` SDK cancel stalled
request-body reads before opening a virtual socket. Actual SDK checks preserve
the caller's abort reason, cancel the source and unlock the reader even when
source cleanup never settles. These streaming-upload checks pass in Chromium
and Playwright WebKit. The tested Firefox native `Request` constructor converts
a `ReadableStream` input to text and exposes no body stream, so that input is
not supported there. This is separate from streamed response delivery, which
the example checks cover in all three engines. No request ponyfill is supplied
for this native input limitation.

The `http-stream-response` runtime and declaration-checked `stjkq5` SDK
consume virtual HTTP response bodies directly. Body methods preserve the
original stream error across Chromium, Firefox and Playwright WebKit, unlike
some native browser response helpers. Shared actual Node controls cover six
body methods, repeated use, clone behavior, split UTF-8, binary views and
multipart files. This applies to virtual HTTP responses returned by the SDK,
not guest-global `Response` or arbitrary native browser fetch responses.
Broad example acceptance for this pair is recorded separately in
`NATIVE_GOAL.md`.

The later `http-failure-mime` runtime and `JDldKA` SDK match the shared Node
body reference for combined content-type headers in Blob and FormData,
including quoted commas and charset carryover. Controlled transport tests
also verify write, malformed-header and truncated-body errors are reported
without waiting for socket close acknowledgement in all three engines.
Cleanup still runs and retains connection capacity until acknowledgement.
These controls do not establish a fix for earlier intermittent installer or
page-context failures, and this pair's framework build checks are separate.

Later source-built native SDK diagnostics, recorded in `NATIVE_GOAL.md`, passed
the four selected TanStack examples and supplementary Solid counter in all
three desktop engines. Compact async-context output also passed three
independent 20-restore WebKit Start basic runs with hydrated interaction. Those
assets have not been accepted as published split packages. TanStack.com's
current example session also provides an interactive terminal and an in-place
restart action. `NativeOwnerClient.restart()` now preserves edits and restarts
the worker without reinstalling dependencies, checked with the Start basic
development preview in Chromium, Firefox, and WebKit. A later local prototype
exposes a same-workspace shell and an interactive xterm panel. Four real
TanStack workbenches passed terminal input and interruption, live file edits
reflected in the editor and preview, builds, panel resize, terminal reopen,
and preview restart in Chromium, Firefox, and WebKit. A terminal-launched Vite
dev server also served HTTP and its client module on a second virtual port in
all three engines, then released that port on Ctrl-C. This is not full PTY or
arbitrary native-binary compatibility. The actual new SolidJS site examples
remain untested.

Astro 7.3.5's stock `npm run build` builds the pinned static-page fixture
through the terminal in Chromium, Firefox, and WebKit, with the expected
output HTML and no browser errors. The native runtime now uses the shared
Node 22.12.0 compatibility target instead of a separate 22.0.0 declaration.
No Astro version guard is changed for these checks. The version is a tooling
compatibility target, not a claim of full Node 22.12 API coverage. Astro
integrations and adapters need separate checks. Stock `npm run dev` also passes
repeated initial HTTP responses, a source edit reflected in subsequent HTML,
and stop releasing its port in Chromium, Firefox, and WebKit. The real preview
also loads Astro's dev toolbar before and after an edit and visibly updates
the page in all three engines, without browser errors on this candidate.
This proves the tested live-reload path, not state-preserving HMR for every
integration or every watcher configuration.

Native project code runs inside a worker on the trusted host origin. That
worker has no DOM, but project code can use worker globals such as `fetch`,
IndexedDB, and Cache Storage with the host origin's authority. A separate
preview origin isolates rendered pages, not code executing in the native
worker. Only run projects and dependencies you trust on a host that carries
site credentials or private data. `close()` can terminate a worker even when
project JavaScript does not yield, and startup/operation deadlines terminate
the worker on timeout. There is no enforced per-project CPU or JavaScript heap
quota, so browser memory pressure can still affect the tab or browser.

The experimental classic worker backend adds synchronous script loading for
`node:vm`. Select it with both `workerType: 'classic'` and
`env: { NATIVE_CLASSIC_VM: '1', NATIVE_BROWSER_MODULES: '1' }` in
`NativeDevServer` options. Host `classic-worker-bootstrap.js` beside the
selected worker bundle. The bootstrap respects the selected engine filename
and its query options. The default remains the module worker/eval backend.

The `selected-engine/0pphDs` artifact passes real terminal checks for retained
function identity, persistent lexical bindings, and recovery after script
errors in Chromium, Firefox and WebKit. It also passes the 30 framework
behavior checks and the terminal workflow suite. This does not establish
isolated VM contexts, hostile-code isolation, or full Node compatibility.
The older eval backend fails the persistent lexical-state control.

The browser VM does not implement Node's per-script execution timeout or
SIGINT interruption. Requests for `timeout` or `breakOnSigint: true` fail with
`ERR_NOT_IMPLEMENTED` before executing code, rather than silently ignoring
the limit. Invalid option types and ranges are checked against Node. Worker
termination deadlines are separate, they do not provide VM timeout semantics
or a hostile-code isolation boundary.

Native project installation currently needs a matching npm v2/v3 lockfile or
an explicit runtime lock. A declared `pnpm install` command is accepted as an
install request, but does not mean pnpm's resolver or workspace-link behavior
runs in the browser. The native project installer rejects npm workspace links
and local `file:` dependency links at both startup and live installation. The
volume's symlink support does not imply installer support. The native runtime
does not support arbitrary lifecycle scripts, Node native addons, or general
shell/process parity. Native file
checkpoints survive page reloads and browser-profile restarts in the tested
desktop engines, but they restart the process and remain subject to browser
storage quota and eviction. Publication is blocked pending shipped dependency
notice review. These are capability and distribution limits, not failures
hidden by example-specific branches.

## Legacy all-in-one candidate history

Everything below describes older all-in-one packages, not the current split
layout. Their `manifest.json` and `candidate-compatibility.json` conventions
apply only to those historical artifacts. Record paths are archival identifiers,
not files shipped in the SDK or guaranteed to be present in a public checkout.
None of these results accepts a new split package or establishes release status.

- **p11JMm**, unpublished package version `0.0.0`, manifest SHA256
  `8608d7e16abb9b1788d8d5d5b1009e2231a9385533410041115be0c8bc009c06`:
  three packaged Vite and three Start workflows pass in each of Chromium and
  Firefox. The stricter consumers separately pass three cold/offline-resume
  cycles per app and browser, including byte-exact restoration and awaited
  shutdown. The candidate auditor validates
  `reports/sdk-p11JMm-desktop-strict-evidence.json`. The four TanStack examples
  pass all eight isolated integration runs and 34 behavior assertions, with
  declared portable dependency adaptations and request cancellations retained
  in `reports/tanstack-four-example-p11JMm-runbook.md`. These results bind tarball
  `f72b812cc1fccf5711832e7b286073150623a0c50660b9b7198711b1158bec31`.
  Actual Safari, distribution clearance, publication and production integration
  remain incomplete. This source-document update does not modify the frozen
  package or retroactively change its compatibility matrix.

- **xIvIoB**, unpublished package version `0.0.0`, manifest SHA256
  `cc2c3029634d5c632590a0ca95cea1b55cd2823e86c0b4c24051f15ee7abb38e`:
  three packaged Vite and Start workflows pass in each of Chromium and Firefox.
  Records are in `test-results/sdk-xIvIoB-chromium-repeated` and
  `test-results/sdk-xIvIoB-firefox-repeated`. The four exact TanStack examples
  also have eight passing browser runs and 34 passing behavior assertions,
  selected in `reports/tanstack-four-example-xIvIoB-runbook.md`. An initial
  Start Basic Firefox run failed while another browser workload was running;
  its unchanged sequential rerun passed. Both records are retained. These
  results use tarball SHA256
  `315ae1b549d535763bc7203a0f8ac0f08ead81a58522782faad31690967a1ab7`.
  Actual Safari acceptance is incomplete. See
  `reports/safari-xIvIoB-follow-up.md` for partial passes, the screen-lock
  confound and an unresolved intermittent install stall. This source document
  does not retroactively update the packaged compatibility matrix.

- **QfShkO**, package version `0.1.0-alpha.0`, manifest SHA256
  `7d36452f83d9ebdf2d94d9ff5b65ff225b22c6de44751da775dbf03c1c35cc32`:
  three Vite and Start cold/save/offline-resume cycles in Chromium, Firefox and
  Playwright WebKit are bound by
  `reports/sdk-6hJUoV-compatibility-evidence.json`. The underlying records are
  in `test-results/sdk-alpha-6hJUoV-vite` and
  `test-results/sdk-alpha-6hJUoV-desktop`. The real TanStack.com integration is
  in `reports/tanstack-site-QfShkO-final-acceptance.json`. These records bind
  tarball SHA256
  `8db6f134112f0dc2856452f9fa77efeb3979f2a2f6f0b81af68e25d00a6c9e0b`.
  Actual Safari remains unverified for this artifact.
