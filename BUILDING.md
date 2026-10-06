# Building the native SDK

The default build profile is `native`. API 8 uses the native browser entry for
both the package root and `/native`. Neither creates a QuickJS kernel.
Legacy profiles remain private diagnostic builds, they are not the release recipe.

The SDK and runtime-support package must have exactly matching versions.
The runtime includes our compiler catalog, browser workers, preview host and
Go/WASM shell. Upstream esbuild and Rolldown WASM stay in pinned npm
dependencies, explicit setup copies them into a verified browser deployment.
See [package usage](src/sdk/NATIVE_PACKAGES.md).

Run the following from the repository root. These commands do not publish.

## 1. Install locked dependencies

```sh
npm ci --ignore-scripts
npm ci --prefix tests/fixtures/native-runtime-832 --ignore-scripts
npm ci --prefix tests/fixtures/native-oxide-build --ignore-scripts
npm ci --prefix tests/fixtures/wasi-filesystem-codec-114 --ignore-scripts
```

Use a clean npm install for this release recipe. The existing pnpm install can
resolve a different transitive dependency tree and produce different compiler
bundles, it is not an interchangeable build input. Compare rebuilds using the
same lockfile, package manager and toolchain.

The shell requires Go 1.27.1 under `.toolchains/go-sdk/go`, plus its module
cache under `.toolchains/go-sdk/gopath`. On Linux x64 or ARM64:

```sh
node scripts/setup-release-toolchains.mjs
```

That script verifies the official Go archive checksum and downloads the
committed shell modules. For another host, install the same Go version from
its official archive and populate the cache:

```sh
GOPATH="$PWD/.toolchains/go-sdk/gopath" \
GOCACHE="$PWD/.toolchains/go-sdk/gocache" \
GOTOOLCHAIN=local \
.toolchains/go-sdk/go/bin/go -C shell/mvdan mod download
```

The build uses that cache offline and rejects a different Go version. You can
set `GOMODCACHE` to another populated module cache. The build asks Go for the
locked module's directory, verifies the cached modules and copies that module's
license, rather than assuming it lives under `GOPATH`.
It disables Go's automatic Git stamp so the shell does not depend on the
checkout revision, dirty state or whether the source came from an archive.
Oxide requires Rust 1.95.0 and the `wasm32-wasip1-threads` target. The release
toolchain setup installs both through rustup. On another host:

```sh
rustup toolchain install 1.95.0 --profile minimal
rustup target add --toolchain 1.95.0 wasm32-wasip1-threads
```

The native release does not need QuickJS, Emscripten, wasm3 or the old
TLS/HTTP2 toolchains.

## 2. Build runtime inputs

```sh
node scripts/build-mvdan-shell.mjs .toolchains/go-sdk
node scripts/build-native-runtime-catalog.mjs
```

`node scripts/build-release-runtime.mjs` runs these same two commands in
order and stops on failure. The catalog reads
`build-inputs/native-runtime-toolchains.json`, producing separate
Vite 8.3.1/Rolldown 1.2.11 and Vite 8.3.2/Rolldown 1.2.12 runtimes.
The catalog builds Oxide once from the source pinned in
`build-inputs/native-oxide.json`, applies our WASI directory-entry patch, then
shares that verified build across both compilers. It checks the source archive,
patch, Cargo lock, Rust version and emnapi static library. Cargo fetches locked
dependencies before an offline compile. Registry sources are checked against
their locked crate archives. The generated WASM must match the named imports
and exports of the pinned npm JavaScript binding, including module names,
kinds and duplicate counts. Descriptor order can differ between build hosts
without changing that named interface. The original WASM bytes and ordered
build records still have exact checksum checks, nothing is rewritten.

The October 4 Linux ARM64 source build and consumer installation pass, but
the full browser check still fails its WebKit deadline. A separate diagnostic
confirms a WebKit process OOM at the same 6 GiB limit, all six directory/context
pairs pass separately. This does not close Linux x64 CI or full Linux acceptance.
See [Linux build evidence](reports/native-linux-build-2026-10-04.md).

The verified npm binding and rebuilt scanner are staged under
`.toolchains/compiler-inputs/<content-sha256>/package`. The build checks every
file before reusing that tree and stops if cached files have changed. Both the
staged package and workspace source are compiled relative to the checkout root,
so temporary extraction paths do not change JavaScript chunk names. This keeps
the compiler's normal package resolution and browser mappings. The staged npm
package remains a dependency input, not workspace source, and the cache is not
shipped in either SDK package or included in source archives.

Each runtime ships `oxide/BUILD.json`, `oxide/RUST-INPUTS.json` and
`oxide/RUST-NOTICES.txt`. The inventory records actual Cargo compiler artifacts,
including host build tools, it is not an exact list of linked bytes. Absolute
source and Cargo registry paths are remapped before compilation.

For an offline rebuild with an already populated Cargo cache, set
`NATIVE_OXIDE_OFFLINE=1`. `NATIVE_OXIDE_SOURCE_ARCHIVE` may point to a cached
source archive, its pinned hash is still checked. Neither option supplies a
replacement binary. The builder leaves its scratch directory intact for
diagnosis and rejects an existing output directory.

Existing `public/` outputs are not proof of a fresh source build.
A publication candidate requires verified notice text for every shipped
dependency and a completed distribution review. Missing notices or review
must stop the release.

## 3. Package

For a private development build:

```sh
SDK_BUILD_PROFILE=native \
SDK_NATIVE_RUNTIME_ROOTS='["public/native-runtimes/vite-8.3.1-rolldown-1.2.11","public/native-runtimes/vite-8.3.2-rolldown-1.2.12"]' \
node scripts/build-sdk.mjs
node scripts/build-sdk-packages.mjs /absolute/path/to/printed-staging
```

This produces a verified internal staging directory, then private `sdk` and
`runtime` packages. Staging evidence stays outside the package pair.

For a publication-format candidate, first finalize all source changes and
runtime generation, then create a new source archive outside the checkout.
Choose the version before building, the version below is an example:

```sh
node scripts/source-snapshot.mjs . /absolute/path/outside/repository/source.tar.gz
SDK_RELEASE=1 \
SDK_RELEASE_VERSION=0.1.0-alpha.0 \
SDK_RELEASE_LICENSE=MIT \
SDK_RELEASE_REPOSITORY_URL=https://github.com/tanstack/container.git \
SDK_SOURCE_ARCHIVE=/absolute/path/outside/repository/source.tar.gz \
SDK_BUILD_PROFILE=native \
SDK_NATIVE_RUNTIME_ROOTS='["public/native-runtimes/vite-8.3.1-rolldown-1.2.11","public/native-runtimes/vite-8.3.2-rolldown-1.2.12"]' \
node scripts/build-sdk.mjs

SDK_SOURCE_ARCHIVE=/absolute/path/outside/repository/source.tar.gz \
node scripts/build-sdk-packages.mjs --publication-candidate /absolute/path/to/printed-staging
```

Keep the source unchanged through packaging and acceptance. Source binding
cannot be added to a previously unbound staging directory. A mismatch requires
a rebuild, not a metadata change.

The explicit split option writes public package metadata before hashing and
testing it. It does not publish or approve anything. The candidate record keeps
`releaseApproved: false`. Repository metadata does not prove repository
availability or production adoption.

## 4. Test the exact package pair

```sh
node scripts/test-sdk-packages.mjs /absolute/path/to/package-build-output
```

This packs and installs both packages in a fresh consumer, checks root and
native exports, public TypeScript in Bundler and NodeNext, consumer bundling,
reproducible tarballs, asset setup and offline reinstall. It requires identical
package and deployment inventories, rejects legacy native runtime assets,
and checks that setup cannot overwrite an existing deployment.

Then use the installed SDK and deployment paths printed by that test:

```sh
./node_modules/.bin/playwright install chromium firefox webkit
node scripts/native-release-acceptance.mjs \
  /absolute/path/to/consumer/node_modules/@tanstack/browser-sandbox-experimental \
  /absolute/path/to/consumer/hosted
```

The browser batch runs the five pinned development examples in Chromium,
Firefox and WebKit, sequentially, with the existing assertions and 180-second
deadlines. It also tests owner files, checkpoints, terminal commands, agent
tools, cancellation, stdin and output limits. Debug filters cannot reduce a
release batch. Package and deployment identities are checked before the batch
and after each browser.

The private `scripts/check-native-sdk.mjs` build also runs ten project and
terminal cycles on one owner connection per browser and compiler version.
This covers HTTP, fresh project files, persistent shell state, Node commands,
stdin/EOF, interruption, replacement and disposal counts without a page reset.
It retains all sixty cycle records and checks the exact installed package and
browser-runner identities. It is not a browser-memory measurement or full-site
soak. To run it separately against a prepared pair:

```sh
NATIVE_OWNER_SOAK=1 \
NATIVE_SDK_BUNDLE_DIR=/absolute/path/to/consumer/node_modules/@tanstack/browser-sandbox-experimental \
NATIVE_DEPLOYMENT_DIR=/absolute/path/to/consumer/hosted \
node --test --test-concurrency=1 tests/native-owner-soak-sdk.test.mjs
```

Original example snapshots and npm locks live in
`tests/fixtures/native-owner-sources`. No neighboring Router checkout is
required. The test does not rewrite the examples to fit the runtime.

The active suite is pinned to Router revision
`b839f47027956f71ed2db51f436701801addb1d6`. The earlier `6f882b7` suite and locks
remain replayable in `reports/inputs/native-examples-6f882b7`.

For the matching real-Node Streaming build control:

```sh
node scripts/control-native-streaming-build.mjs
```

It stages the same pinned bytes in a new temporary directory, runs `npm ci`
without lifecycle scripts, then the example's unchanged `npm run build`.
It retains both command results and rejects changes to the original manifest
or lock. Pass another pinned fixture root as its only argument to replay a
historical suite, no neighboring Router checkout is used.

To measure production separately for every pinned example and engine:

```sh
node scripts/probe-native-owner-production.mjs \
  /absolute/path/to/example-checkout \
  /absolute/path/to/consumer/node_modules/@tanstack/browser-sandbox-experimental \
  /absolute/path/to/consumer/hosted
```

The example checkout contains the original test/helpers, all five pinned
snapshots and their matching fixture locks. Its actual browser dependency
directory must have a locked Playwright 1.63.0 install. The runner uses two
processes at a time, keeps the 180-second deadline per cell, requires all
fifteen cells, and retains failures. Inputs are checked after each cell and
cancelled siblings are drained. Each cell runs the existing declared build-script
API, type checks where declared, restores a production checkpoint, and tests
hydration and progressive streaming. This is not a terminal CLI or full-site
check. A passing matrix does not erase a failed combined workflow.
The existing checker uses the installed JavaScript TypeScript API. When an
example's `tsc` bin selects native TypeScript 7, this is still the sandbox's
compatibility path, not execution of that native compiler binary.

For a direct diagnostic run of `tests/native-owner-sdk.test.mjs`,
`NATIVE_OWNER_STARTUP_OBSERVE=1` saves a failure snapshot before disposal and a
bounded preview request timeline. It records metadata, not response bodies or
query values. `NATIVE_OWNER_MODULE_TRACE=1` with `NATIVE_OWNER_TRACE=1` also logs
the runtime's existing module progress events. These are diagnostic flags,
the release batch clears them and keeps the original assertions and deadlines.

`NATIVE_OWNER_FETCH_CONSUMPTION=1` also records the preview's existing server
function fetch, body-read and reader EOF events without consuming additional
data. This test-only instrumentation can affect timing, a pass does not clear
an intermittent failure. With the installed SDK and deployment environment
variables set, `NATIVE_PREVIEW_RPC_CONTROL=1 node --test
tests/native-preview-rpc-sequence.test.mjs` separately checks sequential
mutations and streams through the deployed preview transport, without a guest
worker or framework. This is a lower-layer control, not example acceptance.

`npm run probe:native-http-pressure -- INSTALLED_SDK DEPLOYMENT [RUNNER_ROOT]`
runs a Node reference and two three-engine pressure controls. The first uses
the current guest HTTP sources in a browser Worker, the second uses the actual
installed owner and native runtime. Both cancel 32 held requests and consume
96 large responses through the same capacity pool. The runner saves logs,
requires all three engines, checks input hashes and stops on failure. Use a
normally installed isolated runner directory when comparing browser versions.
The runner's test and helper files must match the current checkout exactly.
These controls do not replace the five-example or full-site acceptance gates.

`NATIVE_OWNER_WORKER_IO=1` records owner fetch calls and guest Worker socket
sends and replies in the SDK test. It does not send extra messages or read
bodies. Retained event tails and pending maps have separate limits, the console
stream is limited by the diagnostic runner's log budget. Its dispose snapshot
runs before the owner handles disposal, but preview cancellation may already
have started. Use the preceding console events to distinguish the stall from
cleanup. These observations can affect timing and do not replace acceptance.

`scripts/verify-release-packages.mjs` runs this acceptance against a fresh
installed consumer, then rechecks source and package bytes and records results
in `dist/release-verification.json`. It no longer runs QuickJS-only examples
against the native package.

Passing this batch does not prove real-site integration, declared production
builds, actual Safari, the new SolidJS site's full example suite or full Node
compatibility. Those remain separate gates. Do not transfer older candidate
results to a new artifact. The [alpha checklist](ALPHA.md) remains authoritative.

For an already-running isolated TanStack.com fixture, run the complete site
workflow against its installed package and prepared deployment:

```sh
node scripts/repeat-local-native-site.mjs SITE_FIXTURE INSTALLED_SDK DEPLOYMENT \
  --site http://127.0.0.1:4508 --preview http://127.0.0.1:4509 \
  --browser all --runs 3
```

`--runner /absolute/path/to/isolated-runner` selects an existing browser
installation without changing this checkout's dependencies. Copy the five site
test/helper files into its `scripts` directory unchanged. The driver verifies
those hashes and records matching released Playwright package versions, the
actual runner lock and browser catalog before launching, then rechecks them
after each complete workflow. All four prepared project payloads must match
every original source and binary byte, their locks and the installed SDK identity.
It does not install
browsers, retry failed rows, skip interactions or change deadlines. The default
uses this checkout's browser installation. Site receipts cover Counter mutation,
live editing, Run restart and fresh reload, Basic SSR, binary assets, deferred
server functions, interaction and navigation, Router Express SSR and post
navigation, live editing in both, and both progressive streams. These do not
replace the separate expanded terminal or production gates.

To collect the terminal and declared production-build result for every pair
of the four real-site examples and three desktop engines:

```sh
node scripts/probe-local-native-terminal-matrix.mjs SITE_FIXTURE INSTALLED_SDK DEPLOYMENT \
  --site http://127.0.0.1:4508 --preview http://127.0.0.1:4509 \
  --runner /absolute/path/to/isolated-runner
```

The runner also needs unchanged `test-local-native-terminal-examples.mjs` and
`native-terminal-viewport.mjs` in `scripts`, and locked Playwright 1.63.0.
Each pair runs the original checks in a fresh browser process. Failed pairs
stay failed while later pairs run. Cancellation or changed inputs stops the
matrix. Receipts bind example bytes, component and package hashes, the actual
browser dependency lock and browser catalog. `complete` means all 12 pairs
ran, `passed` requires all 12 to pass. Host-page errors are diagnostic in this
terminal driver, use the separate full-site gate for error-free host acceptance.

For repeated terminal checks, run the same complete matrix at least twice:

```sh
node scripts/probe-local-native-terminal-repeats.mjs SITE_FIXTURE INSTALLED_SDK DEPLOYMENT \
  --site http://127.0.0.1:4508 --preview http://127.0.0.1:4509 \
  --runner /absolute/path/to/isolated-runner --runs 2
```

`--runs` accepts 2..5, default 2. Every planned matrix still requires all twelve
pairs and keeps its own receipt. A later pass cannot replace an earlier failure.
Inputs must match throughout. Fresh browsers per pair test repeated workflows,
not a long-lived browser soak. The original deadlines and host-error scope stay
unchanged.

For repeated complete SDK workflows with tracing off:

```sh
node scripts/repeat-native-sdk.mjs INSTALLED_SDK DEPLOYMENT --runs 2
```

This runs the original five-example SDK and owner/terminal/agent test twice
in Chromium, Firefox and WebKit, 30 example runs total. `--runs` accepts 2..5.
`--browser chromium|firefox|webkit` explicitly selects a single-engine diagnostic;
the default is all three. The original commands and deadlines stay unchanged.
The harness checks installed package/deployment inputs, example and runner
sources, locked Playwright versions and the browser catalog between workflows.
It keeps each log and stops on the first failure, with no retry replacing it.
This tests repeated SDK workflows, not a long-lived browser soak, real-site
integration, production builds or publication.

Source snapshots record both compressed gzip and canonical tar hashes.
Different Node/zlib versions can compress the same tar differently. Verification
compares the exact canonical tar and reports the supplied gzip hash, pin the
recorded Node/zlib versions to reproduce compressed bytes.

## Private native CI

For Vite request diagnostics, the owner SDK test accepts
`NATIVE_OWNER_VITE_REQUEST_TRACE=1`. Use `NATIVE_OWNER_TRACE=1` to retain the
progress rows in its console log. The runtime option is
`NATIVE_VITE_REQUEST_TRACE=1` in the process environment. This requires a
source-built diagnostic candidate, it does not patch installed engine bytes.
Observation adds listeners, promise reactions and a timer, so it can affect
timing. It is not a replacement for default acceptance. See the
[captured SSR wait](reports/native-vite-request-trace-2026-10-03.md).

Set `NATIVE_OWNER_VITE_REQUEST_TRACE=stages` for pending inner Vite stages and
resolver plugin names, with `NATIVE_OWNER_TRACE=1` for retained progress logs.
The process environment value is `NATIVE_VITE_REQUEST_TRACE=stages`. This mode
also preserves package-private `#` identifiers. It records bounded pending
metadata, not module source or resolved results. See the
[built-in resolver capture](reports/native-vite-resolver-wait-2026-10-03.md).

The direct callable resolver control has its own hash-bound driver:

```sh
node scripts/probe-native-callable-resolver.mjs INSTALLED_SDK DEPLOYMENT PRIVATE_RUNNER
```

The private runner requires exact `@playwright/test` 1.63.0 and `rolldown`
1.2.11, a package lock, desktop browsers, and unchanged copies of
`tests/native-callable-resolver-reference.mjs`,
`tests/native-callable-resolver-browser.test.mjs`,
`tests/fixtures/native-callable-resolver.mjs` and
`scripts/sdk-browser-assets.mjs` at their relative paths. It records the native
Node reference followed by all three installed-browser controls and fails on
missing resolutions. This is not framework startup or release acceptance.
See the [direct resolver results](reports/native-callable-resolver-2026-10-03.md).

The real Vite pipeline control has a separate driver:

```sh
NATIVE_VITE_PRIVATE_COLD=1 node scripts/probe-native-vite-private.mjs INSTALLED_SDK DEPLOYMENT PRIVATE_RUNNER
```

The private runner needs exact Playwright 1.63.0, Vite 8.3.1 and Rolldown 1.2.11,
with Vite using that same Rolldown version, a normal npm lock and installed
desktop browsers. Copy `tests/native-vite-private-reference.mjs`,
`tests/native-vite-private-browser.test.mjs`,
`tests/fixtures/native-vite-private-imports.mjs`,
`tests/fixtures/native-installed-probe-host.mjs` and
`scripts/sdk-browser-assets.mjs` unchanged at their relative paths.
Omit `NATIVE_VITE_PRIVATE_COLD` for explicit resolver warm-up before transforms.
The receipt keeps direct built-in results separate from pipeline success.
This is not full Start, optimizer, site or release acceptance.
See the [real pipeline results](reports/native-vite-private-pipeline-2026-10-03.md).

`.github/workflows/native-checks.yml` prepares locked dependencies, desktop
browsers and the pinned Linux Go toolchain, then runs:

```sh
node scripts/check-native-sdk.mjs
```

Run that command only in a fresh checkout with the dependencies and Go
prerequisites above. It refuses existing shell or compiler runtime outputs.
It builds both runtimes and a source-bound private `0.0.0` package pair, checks
an installed consumer and offline reinstall, and runs all five pinned examples
and owner/terminal/agent checks in all three engines. Source, package,
deployment and test runner identities must stay unchanged.

The installed checks also cover both compiler versions for Node directory
handles, callback context and command replacement. Each command sequence
finishes or stops a running Node process, starts a replacement, and checks
that no command remains active. The report rejects missing pairs, missing
cancellation cases, browser errors and changed package or browser identities.

Use a coherent locked dependency install. This checkout once had a direct
`@jsonjoy.com/fs-core` 4.68.1 directory alongside memfs 4.70.0 and its own
fs-core 4.70.0 dependency, even though both lockfiles required 4.70.0. That
mixed install failed the root-directory codec test. A fresh locked install
passed. Do not change filesystem behavior to compensate for stale dependencies.

The driver clears inherited publication and diagnostic settings. It records
success or the failed phase in `test-results/native-sdk-check.json`, leaving
failed outputs available for diagnosis. CI uploads that metadata only, not
the source archive, runtime assets or tarballs. This workflow cannot publish
or approve an alpha. It does not replace the real-site or SolidJS suite gates.

## Development diagnostics

Native compiler startup reports download, response-body reading, WASI
initialization, each compiler worker's readiness and binding readiness through
the existing progress events. A command's startup timeout retains the last
received phase. These are metadata boundaries, not a fallback or a larger
deadline, and they do not print to the user's terminal output.

For a separate source-bound development candidate, the full-workflow probe
records each pinned desktop run and stops on the first failure:

```sh
node scripts/probe-native-owner-workflows.mjs INSTALLED_SDK DEPLOYMENT PRIVATE_RUNNER SOURCE_ARCHIVE
```

The private runner needs official Playwright 1.63.0, all three browsers and
exact copies of the test and helper files listed by the driver. The default
mode runs all five examples in Chromium, Firefox and WebKit with observers
off. `repeat-desktop` adds a second Firefox workflow. `callbacks` is a separate
observed Firefox control requiring a callback-instrumented diagnostic build.
`filesystem` requires a build made with `BROWSER_WASI_FS_PROXY_TRACE=1` and
records chunked WASI filesystem reply metadata in Firefox. The trace contains
the method, result/error kind, wire type, encoded byte count and chunk count,
not filenames, arguments, contents or error stacks. The ordinary native build
replaces the pinned Rolldown and Oxide filesystem proxy endpoints with an owned
chunked transport, retaining each upstream codec. The shared lane stays 10 KB and
continuations do not replay filesystem operations. Worker disposal clears held
reply bytes. Example progress capture
does not require module or Vite callback tracing. Diagnostic builds can affect
timing and cannot become publication candidates.
These modes do not run production builds or real-site acceptance. Full logs,
failed results and before/after identities remain in the printed receipt.

The filesystem transport has its own opt-in real-worker control. Use the
existing private Playwright 1.63.0 installation, without changing project locks:

```sh
NATIVE_WASI_FS_PROXY_BROWSER_CONTROL=1 NATIVE_WASI_FS_PROXY_PLAYWRIGHT_ROOT=PRIVATE_RUNNER node --test tests/wasi-fs-proxy-transport-browser.test.mjs
```

It checks the unchanged upstream failures first, then binary chunk boundaries,
large directory and error replies, bigint stats, disposal and termination in
Chromium, Firefox and WebKit. This is transport evidence, not app acceptance.
Set `NATIVE_WASI_FS_PROXY_RUNTIME_ROOT` to the integrity-checked extracted
Oxide package's `node_modules/@napi-rs/wasm-runtime` directory to test its
pinned 1.1.4 codec too. That older codec's chunk-boundary controls use strings,
it does not have the newer Buffer wire type. Do not count that as binary parity.

`interactions` runs the full Firefox workflow on an ordinary installed build
with browser-only click and document-load observation. It records delivery
metadata, not app handlers or contents, and never retries clicks. Four source
checks cover the observer. The separate three-engine control is opt-in:

```sh
NATIVE_PREVIEW_INTERACTION_CONTROL=1 node --test tests/native-preview-interaction-browser.test.mjs
```

Use the private pinned browser runner described above. Its deferred module
control proves document completion alone does not establish handler readiness.
The current ordinary desktop batch passes, but earlier intermittent failures
remain open, see
[click and readiness evidence](reports/native-preview-interaction-2026-10-03.md).

`listeners` adds browser-only click-listener registration and removal
metadata to the full Firefox workflow. `repeat-listeners` runs three complete
fresh Firefox workflows and stops on the first failure. They never retry a
click. Listener IDs and target kinds show native registrations, not invocation
or full application hydration. No function body, argument or app state is
recorded. Callbacks and options pass through unchanged. Stopping recording
restores the owned methods without replacing any newer observer. Callback
wrapping is not used, it changed WebKit's native error reporting in a control.
This can affect timing and is not ordinary release acceptance.

Six source checks cover that observer. Its separate three-engine control
compares native duplicate registration, removal, capture-option getters,
object listeners, once, AbortSignal, original errors and behavior after stopping:

```sh
NATIVE_PREVIEW_CLICK_LISTENER_CONTROL=1 NATIVE_PREVIEW_CLICK_LISTENER_PLAYWRIGHT_ROOT=PRIVATE_RUNNER node --test tests/native-preview-click-listener-browser.test.mjs
```

The control also clicks once before and once after a plain deferred module
installs its button handler. It does not edit the real framework examples.

The current compiler pool defaults to four workers. Diagnostic controls stay
private and are rejected by publication checks. The ordinary Firefox Streaming
failure is still open, see
[the callback and pool report](reports/native-vite-callback-pool-2026-10-03.md).
The next filesystem diagnostic also exposes a streaming interaction failure
without an overflow event, see
[the filesystem reply report](reports/native-wasi-reply-trace-2026-10-03.md).

## Legacy diagnostics

The previous QuickJS build instructions are retained in
[the historical guide](reports/legacy-building-before-native-2026-10-03.md).
They are not instructions for the native alpha release. Legacy all-in-one
test runners and examples do not establish acceptance of the native package.
