# Local TanStack.com integration

This is a local dogfooding fixture, not code bundled into the SDK. Only the four
full-environment examples use the native owner. Other examples keep the site's
existing lightweight workbench.

Prepare it from the current site checkout and an installed SDK package:

```sh
node scripts/prepare-native-site-fixture.mjs SITE_CHECKOUT INSTALLED_SDK
```

The command creates a new directory under `/private/tmp` and prints its path.
It copies tracked working files, including local changes, but excludes
credentials, dependencies, agent configuration, and Wrangler state. It records
the source revision and file hash, installed SDK inventory hash, and pinned
example source and lock hashes in `.native-local/identity.json`.

Install the site's original locked dependencies in that directory:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

Run the owner from this repository, pointing at the installed SDK and its
prepared deployment. The host checks deployment hashes and runtime inventory
before opening ports. Defaults are owner 4197, site 4198, preview 4199.

```sh
NATIVE_SDK_BUNDLE_DIR=INSTALLED_SDK NATIVE_DEPLOYMENT_DIR=PREPARED_DEPLOYMENT node scripts/local-native-site-host.mjs
```

Run the site's Vite dev server in the fixture with these public settings:

```sh
PORT=4198 VITE_LOCAL_NATIVE_SANDBOX=1 VITE_NATIVE_OWNER_ORIGIN=http://127.0.0.1:4197 VITE_NATIVE_PREVIEW_ORIGIN=http://127.0.0.1:4199 VITE_NATIVE_SDK_BUILD_ID=SDK_INVENTORY_SHA256 pnpm exec dotenv -e SITE_CHECKOUT/.env.local -- vite dev --host 127.0.0.1 --port 4198 --strictPort
```

Use the SHA printed by the preparation command. Credentials stay in the site's
existing local environment file, never in the fixture or public settings.
The current site uses `?panel=playground`, the older `?panel=sandbox` selects an
external provider.

The terminal uses `NativeOwnerClient.openTerminalSession()`. Variables, exports,
functions, options, and the working directory live in the shell session, not in
a UI emulation. Hiding the panel keeps that session alive. Run and page teardown
dispose the owner and its sessions.

The terminal and process log use the consuming app's xterm installation, not
a copy bundled into the SDK. The tested lifecycle candidate is
`@xterm/xterm@6.0.0` with `@xterm/addon-fit@0.11.0`, upgraded together.
The site's older 5.5.0/0.10.0 pair has a reproduced disposal callback error.
The separate upgrade fixture leaves the original lockfile available as a
baseline, see the [terminal release comparison](../../reports/native-xterm6-upgrade-2026-10-03.md).

Vite owns preview updates after editor and terminal source changes. Creating
unrelated files or writing application data does not force a document reload.
Use Reload preview when you want a new request to pick up server-side data.

The preview also passes `client.workspaceRevision()` to `URLPreview.mount()`.
That lets the preview recover a source edit made before its live-update
connection opens, rather than leaving the newly loaded document stale.

Checks from this repository:

```sh
NATIVE_TEST_BROWSER=chromium node scripts/test-local-native-site.mjs
NATIVE_BROWSER=chromium NATIVE_SHELL_STATE=1 NATIVE_TOGGLE_TERMINAL=1 NATIVE_FOCUS_BEHAVIOR=1 NATIVE_COMPLETE=1 NATIVE_PASTE=1 NATIVE_STDIN=1 NATIVE_INTERRUPT=1 node scripts/test-local-native-terminal.mjs
NATIVE_BROWSER=chromium node scripts/test-local-native-boot-output.mjs
NATIVE_BROWSER=chromium NATIVE_EXAMPLES=start-basic,basic-ssr-file-based NATIVE_EXAMPLE_REPETITIONS=3 node scripts/test-local-native-terminal-examples.mjs
```

Repeat with `firefox` and `webkit`. Playwright WebKit is not an actual Safari
acceptance result. Type-check the fixture against the installed SDK declarations
with `pnpm exec tsc -p .native-local/typecheck.json --incremental false`.
Start the fixture once before type-checking so content-collections can generate
its existing declarations.

Compare preview file-watch behavior with the exact pinned Counter running in
Node, without changing its source or lockfile:

```sh
node scripts/prepare-native-node-control.mjs react/start-counter
```

In the printed directory, run `npm ci --ignore-scripts --no-audit --no-fund`
and `npm run dev -- --host 127.0.0.1 --port 0 --strictPort`. From this repository,
pass that server's printed URL and the prepared directory:

```sh
NATIVE_NODE_CONTROL_ORIGIN=CONTROL_URL node scripts/probe-native-node-preview-updates.mjs CONTROL_DIRECTORY
```

The control checks unchanged documents after unrelated/data file writes,
explicit reloads, source HMR and post-update interaction in all three engines.
Both controls distinguish rendered SSR from a working click handler. Browser
document load alone does not prove asynchronous route hydration is complete.

The pinned Counter test waits for its existing client-mounted Router devtools
control before clicking. Service-worker responses can make Playwright report
network idle while the document is still loading. This test precondition does
not add a framework hook to the SDK or promise that preview inspection means
application hydration is finished.

The streaming test uses that same client UI precondition before either button.
A captured early click had no React handler and made no streaming RPC request,
the page hydrated afterward. The three-second first-chunk requirement remains.
To repeat the complete four-example workflow with passive network and
chunk observations, keep the site running and use:

```sh
node scripts/repeat-local-native-site.mjs SITE_FIXTURE INSTALLED_SDK PREPARED_DEPLOYMENT --site http://127.0.0.1:4408 --preview http://127.0.0.1:4409 --browser all --runs 3
```

Choose the running site's actual origins. Runs are bounded from one to five.
The workflow checks Counter edits, restart and reload, Basic SSR, binary assets,
deferred server functions and navigation, Router Express SSR and post navigation,
live editing in both, and both streaming buttons. Navigation must preserve the
preview document's identity, not just render the expected text.

The runner checks component, SDK, deployment, all four original project payloads,
dependency locks, the actual browser catalog and test source identities,
clears inherited flags that would narrow coverage, saves
each full run, and stops on the first failure. It does not replace expanded
terminal, production or actual Safari acceptance. Network observations keep
timing and status, never headers, bodies or query values.

Add `NATIVE_SCROLLBACK_FOLLOW=1` to the terminal check to verify that typing
returns to the prompt, background output preserves a scrolled viewport, and
Ctrl+C restores input. Add `NATIVE_TERMINAL_REPETITIONS=3` to repeat the entire
expanded workflow in fresh browsers. Both terminal runners reject unknown
browser names, and the example runner rejects unknown or empty example IDs,
rather than passing without testing anything. Check these inputs with
`node --test tests/native-terminal-runner-inputs.test.mjs`.

Input typed while a command is opening stays queued. It reaches the command's
stdin when that control is ready, or the next prompt if the command does not
accept input. After Ctrl+C it goes to the next prompt, not the cancelled
command. A focused browser control checks these cases and typing from scrollback:

```sh
NATIVE_TERMINAL_TYPEAHEAD_CONTROL=1 \
NATIVE_TERMINAL_TYPEAHEAD_FIXTURE=SITE_FIXTURE \
NATIVE_TERMINAL_TYPEAHEAD_RUNNER=PRIVATE_PLAYWRIGHT_RUNNER \
node --test tests/native-terminal-typeahead-browser.test.mjs
```

Use a prepared private site fixture and the locked Playwright 1.63.0 runner.
The control uses the actual terminal component and the fixture's installed
React and xterm, with controlled command callbacks. It requires all fifteen cases
across Chromium, Firefox and WebKit and records input hashes and xterm's version.
It is opt-in, not part of default CI, and does not replace real shell or site
acceptance. Page and console errors fail this control.

The expanded scrollback check wheels over the visible screen and checks
rendered history, including on xterm 5. Direct `scrollTop` writes can race
xterm's viewport updates. The original failed runs and corrected checks are
recorded in [the input queue report](../../reports/native-terminal-input-queue-2026-10-04.md).

The terminal passes its current columns and rows in the initial shell command
request, not only in a later resize message. Fast commands such as `stty size`
can otherwise finish before that message arrives. Resize messages still update
commands that are already running. Add `NATIVE_RESIZE=1` to check the displayed
terminal dimensions against the child process.
Pointer input also focuses each panel splitter without scrolling the page,
so its arrow-key controls work after a click. The resize check requires that
pointer-to-keyboard transfer, it does not supply programmatic focus.

To isolate a combined terminal/reload failure, keep the prepared site running
and pass its directory to the case runner:

```sh
NATIVE_SITE_FIXTURE=SITE_FIXTURE node scripts/probe-native-terminal-reload-isolation.mjs
```

It checks baseline, toggle, long-edit, clear-edit, word-edit, resize, edits,
edits-resize, toggle-resize and combined cases in Firefox, three fresh browsers
per case. Use
`NATIVE_ISOLATION_CASES=word-edit,combined` to select cases,
`NATIVE_ISOLATION_REPETITIONS=3` to set repetitions, and `NATIVE_BROWSER` to
select another desktop engine. It clears inherited experimental flags, checks
the fixture's recorded integration and SDK inventory hashes, and writes logs,
failure artifacts and a summary to a new temporary directory. Independent
cases continue after a failure, but the runner still exits nonzero if any
case fails or does not complete every planned run. These are diagnostic
controls, not a replacement for the full acceptance workflow.
Check its plan with `node --test tests/native-terminal-reload-isolation.test.mjs`.
Add `NATIVE_HEADLESS=0` to compare the same assertions in a visible automated
browser. The default remains headless, a headed control does not erase a
headless failure.
For native input on an already failed visible workflow, run the terminal
runner directly with `NATIVE_HEADLESS=0 NATIVE_FAILURE_HOLD_MS=120000` and the
desired feature flags. It captures the original failure before holding the
window open, then still exits nonzero. The hold is bounded to two minutes and
is skipped if the browser or page has already closed. It is not forwarded by
the isolation runner. Normal acceptance has no hold.

For Firefox protocol evidence, add `DEBUG=pw:browser,pw:protocol` to a selected case.
Each log retains only the last 2 Mi characters of stdout and stderr, not the
whole run. The raw protocol can contain request data, keep it local. To inspect
navigation and execution-context events without printing evaluated code,
request headers or cookies, use:

```sh
node scripts/summarize-native-firefox-protocol.mjs CAPTURED_LOG
```

The summary also classifies selected browser stderr errors by time, without
copying stacks or app data. Categories are logged evidence, not root causes.
Missing events describe only the captured interval. This summary is diagnostic
evidence, it does not replace normal frame assertions or server interactions.

To isolate streamed iframe navigation from the SDK, Start and the site, run:

```sh
node scripts/probe-browser-streamed-iframe-reload.mjs
```

It uses temporary loopback servers and fresh browser contexts for direct
network, service worker and MessagePort-streamed responses, verifies the response transport, and
requires normal frame reads and clicks after each navigation. The control
includes textarea editing, hide/reopen and layout resizing, not the real
terminal or editor. Defaults are ten reloads per transport in Chromium,
Firefox and WebKit. `NATIVE_BROWSER` and `NATIVE_RELOAD_REPETITIONS` select
one engine or a repeat count from one to fifty. A passing control does not
close a failing full-site workflow.
`NATIVE_RELOAD_TRANSPORTS` selects a unique comma-separated list of `network`,
`service-worker` and `message-port`. `NATIVE_RELOAD_HISTORY=1` adds a
same-document history update in each app document, the default is zero.

For a source-level model of Firefox's context-initialization callbacks, use
trusted installed browser archives only:

```sh
node scripts/probe-firefox-context-initialization.mjs /absolute/path/to/omni.ja
```

The script reads vendor callbacks without modifying the browser. It models
global replacement followed by document insertion, with and without a pending
navigation ID. This can confirm a possible missing-context code path, not
prove the real browser took it or replace browser acceptance.

For preview navigation failures, isolate the installed
SDK from Vite and the site with:

```sh
NATIVE_SDK_BUNDLE_DIR=INSTALLED_SDK NATIVE_BROWSER=firefox node scripts/probe-native-preview-frame-reload.mjs
```

That control uses the existing preview host and checks 20 reloads with a small
counter. Add `NATIVE_RELOAD_TOGGLE=1` to hide and reopen it between reloads.

To keep the real pinned Start Counter and its server calls, but remove the
site layout, editor and xterm, run an isolated owner host in one terminal:

```sh
NATIVE_TEST_SITE=1 NATIVE_SITE_ORIGIN=http://127.0.0.1:4308 NATIVE_OWNER_ORIGIN=http://127.0.0.1:4307 NATIVE_PREVIEW_ORIGIN=http://127.0.0.1:4309 NATIVE_DEPLOYMENT_DIR=PREPARED_DEPLOYMENT NATIVE_SDK_BUNDLE_DIR=INSTALLED_SDK node scripts/local-native-site-host.mjs
```

Then run the control in another terminal:

```sh
NATIVE_SDK_BUNDLE_DIR=INSTALLED_SDK node scripts/probe-native-start-preview-reload.mjs
```

It checks ten reloads and server mutations per desktop test engine, using
distinct counter values to avoid matching the outgoing document. Set
`NATIVE_BROWSER=firefox` to select one engine, `NATIVE_RELOAD_REPETITIONS=20`
to repeat longer, or `NATIVE_RELOAD_PRELUDE=background` to add noisy output,
interruption, a shell directory change and piped file writes. Set
`NATIVE_RELOAD_WRITER=owner` to compare direct SDK writes with shell writes.
Failure inspection is diagnostic only, it cannot turn a failed frame check
into a pass. Neither reload control replaces the full-site acceptance tests.

The four native example routes select `require-corp` isolation headers. Other
examples retain the external editor's `credentialless` policy. Verify that
selection with `node scripts/test-local-native-site-headers.mjs`. The site
behavior test also checks that native documents are actually isolated, a
successful HTML response alone does not prove the sandbox can start.

The original streaming example's declared production build has a known
TypeScript failure. Keep that separate from development and progressive-stream
acceptance, do not rewrite its source to claim a passing build.
