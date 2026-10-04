# Historical alpha notes, archived September 23, 2026

The previous ALPHA.md is preserved verbatim below. Its status claims, checkboxes
and commands describe earlier states and may contradict each other. This is
historical evidence, not a release gate. Use ../ALPHA.md for the active checklist.

---

# Browser sandbox alpha launch checklist

This is the launch checklist. Historical experiments live in
[goal-coverage.md](reports/goal-coverage.md), not a second release gate.
The alpha is not ready to release.

Current split candidate `ai9akL` is built from source API 6 and includes the
deterministic compiler dependency graph. Fresh npm adoption passes installation,
153-file deployment verification and Vite bundling. All twelve WASM inputs match
the earlier p11JMm staging bytes. The release compatibility checker accepts the
required 5-to-6 API bump and finds no removed runtime paths, hosting contract
change or profile change. This is not publication approval. Its own twelve-run
Chromium/Firefox batch is running in `test-results/sdk-split-ai9akL-desktop`;
no outcome is claimed yet. The isolated site's pnpm install and public asset
setup now pass without dependency-version overrides. Its new browser matrix
remains pending. Exact package and deployment identities are recorded in
`reports/tanstack-split-package-migration.md`.

Packaging cleanup now has private split SDK/runtime candidates. Upstream compiler
WASM and pthread code are resolved from pinned npm dependencies during explicit
consumer asset setup, not included in our tarballs. Eleven focused tests pass.
A fresh consumer installs both tarballs, assembles 153 deployment files, verifies
them and bundles the SDK with Vite. Chromium boots the assembled worker and
returns an idle resource snapshot under cross-origin isolation. This is not
full Vite/Start acceptance. Basic and framework examples now use the split layout.
An initial Chromium run passes Vite and Start edits/resume on candidate 3Vqx6S
using repository examples. Candidate MhXC2w includes those examples in its
tarball; all twelve runs pass, three rounds per workflow in Chromium and Firefox.
The paired evidence checker passes in
`reports/framework-split-MhXC2w-desktop-batch.json`. This is the frozen API-v5
split experiment, not acceptance of the subsequent source changes.
Split compatibility and publication-identity verifiers now have focused tests;
they do not approve these private candidates for release. The isolated site's
pnpm install exposed a compiler dependency-resolution mismatch: asset setup
rejects nested `@tybys/wasm-util@0.10.3` instead of the pinned `0.10.4`. npm's
deduplication had masked this. Source now resolves the compiler graph through
pinned direct dependencies while retaining version, hash and package-root checks.
A conflicting nested-version regression passes. Source API is now 6, and staging
is explicitly internal and private. Fresh package and site verification of these
changes remains required. See
`reports/tanstack-split-package-migration.md`.
Build instructions: `BUILDING.md`; consumer usage:
`src/sdk/PACKAGES.md`. No packages were published.

Current candidate `p11JMm` passes three Vite and three Start cold/offline-resume
workflows in both Chromium and Firefox, including edits, fresh script results,
byte-exact restoration and acknowledged shutdown. Plain and strict evidence:
`reports/framework-p11JMm-desktop-batch.json` and
`reports/sdk-p11JMm-desktop-strict-evidence.json`.

The same-package isolated TanStack.com matrix passes eight runs and 34 behavior
assertions across Counter, Basic, Streaming and Router SSR. Portable dependency
changes remain explicit, and the original site's package and lockfile are
unchanged. This is not production deployment evidence. See
`reports/tanstack-four-example-p11JMm-runbook.md`.

Actual Safari acceptance remains open. The earlier ordinary p11JMm run passes
two complete Vite/Start cold/resume rounds, then stalls during the third Vite
install at the unchanged inactivity deadline. The later HpZicc preview-liveness
diagnostic completes three Start cold/resume rounds, but remains
`diagnosticOnly: true` and `passed: false`. It neither establishes an install
fix nor transfers acceptance to p11JMm. The ordinary p11JMm rerun passes round
one's Vite cold/resume and Start cold workflow, then loses WebDriver responses
while checking the resumed Start server-function reply. Independent owner
samples continue, and fresh Safari recovery passes. Repeated Safari acceptance
remains failed. Evidence: `reports/safari-p11JMm-final-desktop-candidate.json`.
Details and retained failures:
`reports/safari-p11JMm-follow-up.md`.

The Xcode prerequisite is resolved. The pinned offline Rolldown build and
upstream postprocessing complete, but the rebuilt WASM does not match the
shipped parser. Final linker evidence confirms retained code from three crates
whose notices remain unresolved; all four notice records remain open. No SDK
binary was replaced. This is retained audit history, not a requirement to obtain
author permission or reproduce the upstream binary before using MIT software.
Preserve supplied notices in package/deployment outputs and document unresolved
upstream attribution questions. No maintainer inquiry has been sent. See
`reports/rolldown-rust-notice-review.md`.

The frozen package passes isolated install, both TypeScript resolution modes,
Vite bundling, uninstall/reinstall and acquisition-cancellation checks, with
reproducible tarballs. These establish local adoption, not publication or
license clearance. See `reports/native-buffer-utf8.md`.

New candidate `qTx8nU` includes constant-time filesystem quota accounting.
It removes repeated whole-workspace scans during file extraction while retaining
open-file accounting and synchronous quota checks. Eight new regression tests
pass, and the broader filesystem/install suite passes 142 tests with typecheck.
The package passes isolated install, typecheck, bundle and reinstall checks.
Manifest SHA256: `46bd1d3f87f408d4b4818898c1f37b7f49f487a0369dfd1d1c4cd1c0bf242593`.
Tarball SHA256: `304f2bb034dc47bd0655c19a775f6c57f24171e4e8b52b2739df0a20394150e6`.
Its actual Safari run passes the first Vite cold/resume cycle, then fails in
Start's first cold cycle with WebDriver timeouts. Worker resource samples
continue after installation, unlike the earlier install-heartbeat stall.
Evidence: `reports/safari-qTx8nU-framework-acceptance.json`. This does not prove
that the intermittent install stall is fixed. No deadlines were changed.
The new package passes all six Chromium packaged-example workflows, three
Vite and three Start runs, in `test-results/sdk-qTx8nU-chromium-repeated`.
These now retain observed test exits, phase outcomes and offline/Stop evidence
at their assertion sites. Firefox finishes with three passing Vite runs and
three failed Start cold-hydration runs after installation and preview attachment.
All failures are retained in `test-results/sdk-qTx8nU-firefox-repeated`, so this
candidate fails the repeated Firefox gate. A manifest comparison confirms the
selected native-UTF8 fiber WASM is unchanged from xIvIoB, but five other engine
binaries differ. This is a current-source candidate, not a filesystem-only
controlled comparison.
The targeted Firefox completion trace rules out a final socket-cleanup wait:
ten optimized dependencies have not reached close at all. Two return headers
without bodies, and eight have no completed read. Follow-up scheduling and
phase diagnostics show continued host completions, with most measured execution
time spent in guest promise jobs, not filesystem callbacks or native WASM calls.
An opt-in guest-function sampling build identifies that work.
It is diagnostic only, with unchanged application deadlines and
scheduling. That diagnostic now identifies Buffer UTF-8 work: 268 of the latest
512 branch samples are in `utf8Encode`, and 56 in `utf8Slice`. The native path
currently covers string-to-Buffer creation but not byte counting or writes.
Next extend those operations with Node-equivalence tests, then repeat the real
app. See `reports/guest-function-sampling.md` and
`reports/firefox-qTx8nU-completion.md`.

Previous candidate: `xIvIoB` passes three plain Vite workflows and three plain
Start workflows in each of Chromium and Firefox. These use the
packaged example, original deadlines and no diagnostic wrappers. All twelve
have zero observed errors and pending requests. The candidate fixes native
UTF-8 handling of rope strings and retains the large-response speedup.
Earlier Firefox cold-start misses remain recorded. The same-package site
matrix now has eight passing reports and 34 passing behavior assertions.
Actual Safari acceptance is still needed.
The unlocked Mac now has an actual Safari 26.6.2 run of this exact package.
All three Vite cold/resume rounds and all three Start cold rounds pass.
Start offline resume passes twice, then fails the counter interaction in
round three after hydration. The browser remains available, unlike the earlier
process-loss failures. This is progress, not repeated Safari acceptance.
Evidence: `reports/safari-xIvIoB-framework-acceptance.json`.
The macOS lock timestamp falls 29.395 seconds into that final Start resume,
so the missed trusted click is confounded by the screen locking mid-run.
The follow-up stops at the visible-owner precondition. Repeat with the screen
continuously unlocked before treating this as a runtime interaction defect.
The harness now preserves mid-interaction visibility loss and reports
`safari-not-visible` separately. All 21 harness and exact-package-consumer
checks pass; the full visible Safari rerun remains blocked by the locked Mac.
The Mac was subsequently unlocked. The first new full run failed at Vite
installation after 150 seconds without activity. Three Vite-only diagnostic
rounds then passed; the cause of the intermittent stall is unproven. A second
full batch also fails at the same install deadline while visible. Full-batch
retries are stopped in favor of a bounded worker-message diagnostic.
That diagnostic shows init replied and install made progress before heartbeats
also stopped. A later Vite-only run passes all three rounds without reproducing
the stall. Next isolate install stages rather than repeat the full batch.
Details: `reports/safari-xIvIoB-follow-up.md`.
In the new site matrix, all four examples pass both browsers. Start Basic's
first Firefox run hits Nitro's own 30-second reload
deadline while Safari is also running. The unchanged sequential rerun passes;
the original failure remains recorded. See
`reports/tanstack-four-example-xIvIoB-runbook.md` for the exact report selection.

Current work: `u98Ls8` passes all twelve Chromium/Firefox development workflows.
Its same-package four-example site matrix passes all eight Chromium/Firefox
runs and all 34 behavior assertions in an isolated site copy.
The segmented Safari diagnostic `bHbYhH` renders Start SSR but fails hydration,
so it remains rejected for app acceptance. Investigate its cancellation and
dispatch overhead without changing timeouts or promoting it to the default.
The opt-in persistent-state interpreter variant `68e3f8c5` compiles and passes
the transition, property and ALS checks. Diagnostic SDK `2Q7LTB` is packaged.
Its Safari run stopped before opening the app because the Mac session was
locked. Unlocking the Mac is required for that visible-window acceptance test.
The new package passes all six headless Chromium workflows, three Vite and
three Start cold/edit/save/reload/offline-resume runs. Firefox Vite passes 3/3,
but Start fails 3/3 at the original 60-second cold hydration check after SSR.
It remains diagnostic, not a replacement for `u98Ls8`. Actual Safari app
acceptance for this new interpreter remains unverified.
The targeted Firefox snapshot shows completed SSR streaming but an interactive
document with client hydration incomplete and no page-observed pending requests.
Matched response captures show identical shared client JavaScript, but the
candidate capture has no optimized dependency responses and lacks the final
three ordinary modules. React Refresh starts, while Start options remain unset.
The bridge trace confirms all thirteen missing JavaScript requests were
forwarded, despite the page observer reporting no pending requests. Trace
owner RPC and compiler completion next, not missing browser fetches.
Do not assume that the arithmetic slowdown explains the app failure.

Binary socket writes now avoid JSON byte-array serialization. All 39 network
checks pass across Chromium, Firefox and Playwright WebKit, including sliced
views, ownership and size limits. The matched `jbPSid` package reduces a 1 MiB response's post-header
transfer from 692.62 ms to 12.82 ms in a single Firefox diagnostic, but Start
still fails the original cold hydration deadline. The last three ordinary
modules now complete. Keep this package diagnostic and investigate the
remaining pre-header work. Details: [binary socket fix](reports/binary-socket-write-jbPSid.md).

The opt-in native UTF-8 package `aG4vNE` reduces the ordinary 1 MiB Firefox
response to 49.90 ms with correct bytes, but introduces corrupted JavaScript
inside Start's streamed HTML bootstrap. It fails cold hydration and must not
be promoted. Five direct engine checks and a delayed HTTP streaming fixture
pass, so the full app remains the deciding reproduction. Details:
[native UTF-8 diagnostic](reports/native-utf8-aG4vNE.md).
The corruption is now reproduced with QuickJS rope strings. The encoder used
the flat-string layout without normalizing ropes. The fixed engine passes six
direct checks, including that regression. Separate package `xIvIoB` initially
missed Firefox's cold hydration deadline, then passed the full plain repeated
batch described above. Its ordinary 1 MiB response takes 56.36 ms, and its
guest-concatenated streaming fixture passes. It is not the release default.
The failed Firefox trace confirms committed optimizer output and HTTP 200
headers for all ten stalled dependency requests, followed by incomplete bodies.
The successful trace completes those responses with valid final chunks.

Source-only follow-ups: fiber host-boundary deadline reporting now reuses the
existing interrupt reporter, verified by parked-wait/recovery checks in all
three Playwright engines. Public release validation now rejects incomplete
hash-bound distribution review and missing notice evidence. Neither source
change is part of the already tested `2Q7LTB` package.

## Active goal scope

User-confirmed scope, September 18, 2026: continue the existing goal through
ordinary app compatibility, reliability, SDK adoption and TanStack.com
integration. Use owned local fixtures and public packages. Security research,
sandbox-escape research, exploit development and adversarial probes are deferred.
Preserve existing protections, permission checks, resource limits and warnings.
Security assurance remains unverified, and no release may claim that hostile
code can run safely.

Continue with ordinary functional tests: package installation, cancellation,
worker startup and shutdown, filesystem persistence, Node API behavior,
framework builds, previews and save/resume. Use normal app inputs and bounded
test fixtures, not exploit payloads or attempts to cross isolation boundaries.
Prioritize repeated exact-artifact desktop workflow checks and actual Safari
acceptance, then move the proven standalone SDK artifact into the TanStack.com
integration.

If an experiment is blocked, record what remains unverified and move to an
independent functional requirement. Do not rephrase or disguise the same
experiment to get around a block.

## Historical milestone log

The notes below preserve the experiments that led to the current candidate.
They are not the active release status. Use the launch gates below and the
candidate's generated compatibility record for current claims.

The user approved a test-only local TanStack.com integration. The site now has
an opt-in Start counter panel selected by `VITE_LOCAL_BROWSER_SANDBOX=1` in
development; its normal WebContainer workbench remains the default. Retained
integration evidence uses the exact QA3oVl tarball as a local development
dependency. It is not a published or deployable release dependency.
Existing unrelated site changes are retained.
The panel checks its displayed source against the local fixture hashes, then
uses the public SDK for installation, processes, file edits and owned previews.
It does not expose unsupported terminal or browser-control features.

The site type check passes with `--noEmit --incremental false`. Sixteen adapter
lifecycle regressions pass via
`node --test integrations/tanstack-site/adapter.test.mjs`. These mock the SDK
and do not prove browser execution. The first browser attempt found missing
isolation headers on the new asset middleware; the headers are now explicit.
A Vite restart also found preview-host ownership problems; a plugin close hook
did not resolve them. Preview hosting now runs as a separate loopback process,
independent of site hot reloads. The next browser attempt installed all 122
packages but failed preview startup with ECONNREFUSED. The adapter now selects
the fixture's explicit port 3000 instead of the first observed listener.
Selecting port 3000 alone did not resolve startup. The managed bootstrap now
signals after Vite finishes listening, and the adapter waits for both the port
and that signal. The real page then rendered SSR successfully. Its first click
check ran before hydration, so the browser test now uses the same retained
Start bootstrap observation as the existing acceptance test. The corrected
Chromium run passes on the real TanStack.com route. It covers a cold run, SSR,
hydration, two server-function calls, an editor live update, worker-owned save,
a real owner-page reload, offline resume without dependency installation,
restored editor source and server data, another live update and two more
server-function calls before clean Stop. A catch-all Playwright route used only
to observe resume traffic caused the earlier click hang; replacing it with
passive request observation preserved the offline assertion and removed the
deadlock. Command: `node integrations/tanstack-site/check.mjs`, terminal exit 0.
The exact installed QA3oVl run reached cold SSR 9.371 seconds after Run, cold
hydration in 19.976 seconds, saved at 24.428 seconds, resumed hydration at
37.976 seconds and clean shutdown at 40.677 seconds. The retained report binds
manifest SHA256
`97e09d7479d7736712fe583a38148af7b536e054ed390973cab5234b2bd6417a`
to final tarball SHA256
`8fbff813e04949fe05c591e0aefccea3ecd1cf6931315aed4bf074a820fa343f`,
the selected TanStack.com project identity, the 6,820-file saved workspace,
zero unclassified browser diagnostics, zero resume dependency requests from
the worker or preview, and clean Stop. The harness explicitly blocked and
recorded two Sentry telemetry attempts. Evidence:
`reports/tanstack-site-QA3oVl-acceptance.json`. This is one local Chromium
integration pass, not repeated browser acceptance, actual Safari support or a
production deployment.

A same-app WebContainer 1.6.1 comparison did not reach preview. It installed
122 packages, then the Start dev server exited under Node 22.22.3 with
`ERR_NAPI_BINDING_TARGET_CONFLICT`. Its runtime frames attached around 2.0 and
2.3 seconds after navigation, but those are not boot or app-ready measurements.
The SDK's fresh-context integration sample reached SSR 11.290 seconds after Run,
hydration 24.244 seconds after Run, completed its first server-function result
809 ms later, and acknowledged shutdown with no preview iframe at 27.087 seconds
after Run. This is a single timing sample. See
`reports/webcontainer-comparison-2026-09-19.md`; do not claim a speed winner.

Open a project, install supported dependencies, run the app, edit it, preview
the change, save, reload the host page and resume. Ship this for a real Vite
frontend and a representative TanStack Start app through the public SDK.

Repeat those workflows on the same current SDK artifact in desktop Chromium,
Firefox and actual Safari, then verify one real TanStack.com example on that
same artifact.
The Start resume check must use a persisted public kernel snapshot, a real
host-page reload and a fresh kernel. Restore edited source, counter data,
installed packages and cache files before spawning, with external dependency
requests blocked and recorded. Keep owner assets available, so this proves
offline workspace/dependency restore, not offline hosting or live-process restore.
Do not increase limits to make a test
pass, remove caches on resume, serialize application operations, or silently
substitute dependency versions.

## Launch gates

- [x] Real apps: manifest `42799f37bd888a7888493cbd2efdf9f8a10688eacbfc74f45392005da2ebfcd7` passes three cold and
  resumed Vite 7 cycles and three cold and resumed TanStack Start cycles in
  Chromium, Firefox, and Playwright WebKit. The earlier QfShkO candidate passes the four exact
  TanStack comparison examples in Chromium and Firefox, 8 of 8 runs and 34 of
  34 behavior assertions. This does not claim every Vite plugin, Start feature,
  or Node package works.
  The newer `42799f` four-example rerun passes 7 of 8 browser/example cells.
  Firefox's streaming example misses hydration after Vite optimizer reloads
  cancel entry-module requests. The service worker now forwards request aborts
  and cleans up synchronous bridge-dispatch failures. Focused tests pass, but
  the exact-package Firefox run still fails. Candidate `xrbMSP` now forwards
  browser-owned document lifecycle cancellation, and a bounded browser trace
  confirms both cancellations reach the owner's AbortController before Firefox
  reports the corresponding aborted requests. Closing the socket does not stop
  Vite's active transform pipeline. The remaining investigation is transform
  and optimizer work, not another transport cancellation change. The earlier
  8-of-8 result must not be used to hide this regression.
  The actual Firefox streaming acceptance now passes all five assertions with
  only the served site's fine-grained `profileJobs` option disabled. This option
  changes guest job batches from 100 to 1. Ordinary diagnostics remain enabled.
  See `reports/firefox-streaming-bottleneck-v3.md`. Because this pass used a
  response override, three clean runs followed. All three pass the same five
  assertions without an override, with zero page or console errors. Hydration
  takes 83.0 to 85.8 seconds of the unchanged 90-second allowance, so performance
  margin remains small. This closes the exact Firefox streaming regression on
  `xrbMSP`, not a claim that all four examples were rerun on that artifact.
  The permanent adapter now omits
  `profileJobs` while retaining `diagnostics`; its lifecycle regression suite
  passes all 17 tests. Adapter SHA-256:
  `3f64886d22fc3dce2cf036dd9179e170874e221dff7969ee62554a1ec709b654`.
  The separate `xrbMSP` public SDK Firefox workflow rerun passed 5 of 6 runs:
  Vite 3 of 3 and Start 2 of 3. Its first Start round completed Save after the unchanged
  five-second assertion expired. This does not invalidate the streaming pass,
  but it prevents carrying the older candidate's full workflow acceptance
  forward. The source example's stop-before-save change also passed only 2 of
  3 Start runs, with the same five-second Save miss in the failed run. It removes
  unnecessary work but does not resolve this gate. The next diagnostic separates
  shutdown, snapshot capture and encoding, IndexedDB storage, and session close.
  Source-only runs do not count as packaged acceptance.
  The corrected timing run measured 4,154.3 ms total Save time: 281.9 ms stop,
  47.1 ms raw kernel snapshot, 2,818.8 ms snapshot wrapper/base64 encoding,
  1,005.1 ms IndexedDB storage, and 1.1 ms close. Binary browser persistence is
  implemented as an additive public `snapshot({encoding:'binary'})` option.
  Base64 remains the default for JSON/tool use, and restore accepts both formats.
  Focused tests preserve bytes, directories, symlinks and modes, including old
  JSON snapshots. Generated types retain precise literal return types and accept
  dynamic encoding options. The example uses binary IndexedDB storage, with
  diagnostic method wrapping removed. Candidate `u98Ls8` passes all six packaged
  Chromium workflows and all six Firefox workflows, three Vite and three Start
  per browser, without source overrides or deadline changes. Each Start run
  passes the original five-second Save gate. All twelve runs use manifest
  `c26b6bd2e225e2cca40f9ae09d200068f43b3d974ad907f531827e377bc2bb8f`
  and tarball `08b47fd41e4c6067b4b591ab204454b62240501ccb174cb87d363cb65f6f45c4`.
  Actual Safari remains open.
  The first timing attempt lost its output on reload and is not timing evidence.
- [x] Development loop: the current candidate loads projects, installs supported
  dependencies, runs declared scripts and tests, reports output, edits files,
  serves previews, saves snapshots, reloads the owner, and resumes without
  reinstalling dependencies. The earlier QfShkO TanStack.com lifecycle restored 6,819
  files and 121,736,077 bytes, then completed more live edits and server calls.
- [ ] Desktop support: repeated cold and resumed workflows pass in Chromium,
  Firefox and actual Safari. Chromium, Firefox, and Playwright WebKit have three
  passing Vite and Start cycles per phase on manifest
  `42799f37bd888a7888493cbd2efdf9f8a10688eacbfc74f45392005da2ebfcd7`.
  Actual Safari 26.6.2 completed one Vite cold/resume cycle. After fixing two
  Safari test-harness errors, Start completed its cold interaction and save
  steps, but resume terminated WebContent at its active memory limit. The
  aggregate Start result remains failed, not accepted. See
  `reports/safari-framework-acceptance-final-v3-rerun2.json` and
  `reports/safari-active-memory-limit-final-v3.json`. Compile-only checks stayed
  bounded, and an isolated parser workload stayed below 1 GB; neither reproduced
  the full workflow's 11-13 GB growth. The repeated Safari gate remains open.
  Playwright WebKit does not count as Safari evidence.
  A matched actual-Safari fiber-only workload reproduces the memory growth
  without a parser or compiler. Disabling compiler inlining reduces settled
  memory from roughly 5.5 GB to 129 MB, at about 60% more execution time for
  that workload. This is diagnostic evidence, not an accepted app-level fix.
  Narrower source-level changes did not resolve the issue. A separate diagnostic
  SDK with global compiler inlining disabled now passes three actual Safari
  Start cold and offline-resume cycles, including edits, interactions, save and
  acknowledged shutdown. Its manifest is
  `56b32fc0ad1404600add5b0a3975cb841f19531946e0aa9cc45b3f502dc92cf8`;
  evidence is `reports/safari-start-noinline-acceptance-final-v3.json`.
  Vite was not run in that invocation. Observed WebContent memory still reached
  roughly 6.5 GB, so this is functional progress, not a portable memory fix or
  approval to change the released engine. Default engine assets remain unchanged.
  A later run of that same diagnostic artifact failed waiting for Save after
  app rendering, edits and interaction passed. It never reached its planned
  post-shutdown idle measurement. See
  `reports/safari-start-noinline-post-shutdown-memory-final-v3.json`.
  Fresh Safari recovery passed. Memory return after shutdown remains unverified,
  and the earlier three successful rounds do not establish reliable Save.
  Static analysis now points to decomposing the large QuickJS opcode dispatcher.
  Its frame must remain Asyncify-instrumented because synchronous guest I/O
  suspends through it. An opt-in property-opcode split now builds. Against a
  matched compiler-policy control, it reduces the main interpreter body from
  74,933 to 57,453 bytes, moving the property family into a 17,319-byte helper.
  Suspension, exception, cancellation, ALS and deep-call tests pass on both
  exact control and candidate engines. See
  `reports/interpreter-property-split-semantics-final-v3.json` and
  `reports/quickjs-interpreter-property-decomposition.json`.
  Actual Safari then completed the same 20-cycle workload on both engines.
  After the unchanged ten-second observation period, the control used
  3,991,424 KiB and the split used 3,450,064 KiB, a 13.56% reduction but still
  about 3.29 GiB. See `reports/safari-fiber-property-split-comparison-final-v3.json`.
  This is not enough to approve the candidate for full-app packaging. The next
  implementation is complete opcode-handler segmentation with frame ownership
  retained in one coordinator, not more compiler-flag experiments. The default
  engine remains unchanged.
  That opt-in candidate now builds as WASM SHA-256
  `851ae0ec12ec2c7bd6ab95e15248ebf56ab293499db2228f28b714b6179773ee`.
  Its coordinator is 19,200 bytes and largest handler 17,594 bytes. Differential
  tests pass for typed call/return/yield transitions, dynamic imports that suspend
  in the production-style job pump, generators, coercions, cancellation and ALS.
  Actual Safari then completed only 11 of 20 cycles within the unchanged
  120-second deadline. Memory stayed near 644,000 KiB, but later cycles took
  about 16 seconds each. This is a failed workload, not browser acceptance.
  Because completed work differs, do not report a memory-reduction percentage
  against the completed control. See
  `reports/safari-fiber-interpreter-machine-comparison-final-v3.json`.
  The exact WebContent CPU report subsequently showed concurrent `wasm-opt`
  compilation dominating sampled CPU during that run. Its timing is confounded,
  not proof of a Safari tiering or dispatch cause. A separate matched Node loop
  test did measure a 3.9x regression, which is not proof of the Safari timeout's
  cause. A rerun without competing task builds ended after nine cycles with
  WebDriver `no such window`, not a workload timeout. Its last recorded main
  WebContent sample was 636,624 KiB. OS logs show an unexplained Quit AppleEvent,
  followed by a GPU process crash and WebContent connection loss. No memory-limit
  termination was found. The quit initiator remains unknown, so this is not a
  passing workload or proof of an engine memory failure. The fiber runner now
  records pre-cleanup process and window state and cleans up only its owned
  Safari process. See
  `reports/safari-fiber-interpreter-machine-isolated-window-loss-final-v3.json`.
  The next ownership-scoped attempt failed before loading the workload because
  SafariDriver timed out querying an initial window handle. A standalone local
  document check succeeded. The probe now navigates to an initialization
  document before capturing window handles, without changing guest work or its
  deadline. With that initialization, actual Safari 26.6.2 completes all 20
  cycles in 92,771 ms. The measured workload WebContent PID uses 646,496 KiB at
  completion and 646,064 KiB after the unchanged ten-second settle period.
  Evidence: `reports/safari-fiber-interpreter-machine-candidate-851ae0ec-document-owned-final-v3.json`.
  This clears the bounded interpreter diagnostic, not full-app acceptance.
  The next step is an explicit diagnostic SDK build profile containing this
  exact segmented engine and the binary Save API, then real Start cold/resume
  checks under the existing limits. Default engine assets remain unchanged.
  That diagnostic package, `bHbYhH`, now exists with explicit profile selection
  and unchanged public runtime policies. Its manifest is
  `9adc6a20bdde316accb92ae7ab6863d0ebfede31041a5ac632f6d9a256d8c0f8`.
  Actual Safari installed 117 packages and rendered Start's SSR heading, but
  hydration failed in the first cold round. Output reported `Fiber call cancelled`;
  save and resume were not reached. Fresh Safari recovery passed. This rejects
  the current segmented package for app acceptance. See
  `reports/segmented-sdk-bHbYhH.md` and `reports/safari-start-segmented-bHbYhH.json`.
  The cancellation cause is not established by that output alone.
  No timeout extensions
  or compiler-flag sweeps are allowed. This engine
  is not being packaged; binary Save acceptance uses the unchanged xrb runtime
  binaries in candidate `u98Ls8`, manifest
  `c26b6bd2e225e2cca40f9ae09d200068f43b3d974ad907f531827e377bc2bb8f`.
  The source example now stops its app before saving editor changes and avoids
  rewriting unchanged source. Two actual-handler regression tests cover dirty
  and unchanged editor content. This removes unnecessary rebuild work before
  cancellation. It is packaged in `u98Ls8`, but is not verified as a Safari fix.
- [ ] Adoption candidate: the package has a public API, TypeScript declarations,
  install and hosting docs, basic and framework examples, an MIT project license,
  third-party notice inventory, an exact-artifact compatibility matrix, and a
  reproducible tarball. A fresh external Vite consumer installs and bundles
  using only public package exports. The fresh-source build recipe has been
  exercised; complete third-party notice coverage remains open. The source archive excludes local
  toolchains and generated assets; its exact hash alone does not prove someone
  else can rebuild the SDK.
  `BUILDING.md` now records the ordered recipe. HTTP/2 and TLS were rebuilt
  identically in two extraction roots and adopted after 42 browser checks and
  22 Node interoperability cases passed. Full SDK build and external-consumer
  validation passed for `xrbMSP`, documented in
  `reports/fresh-source-build-evidence.md`. The missing napi-rs runtime notice is now pinned to its
  npm-recorded upstream commit. The Rolldown binding's top-level notice is now
  pinned to the source commit in its npm registry provenance statement, with
  the statement's package digest checked against the lock. Its signature has
  not been independently verified here. Embedded dependency notice coverage
  remains open. The package now includes 134 unique full Rust notice texts,
  revision-bound supplemental notices and Emscripten runtime notices. Four
  Rust package notice records remain unresolved; the inventory is conservative,
  not proof that every listed dependency is linked into the binary. The source
  tree now also has hash-bound Rust 1.98.1 standard-library and WASI SDK 33
  notices, including pinned wasi-libc and LLVM revisions, with a writer that
  refuses a different Rolldown version or WASM hash. Candidate `xrbMSP`
  predates them, but the 13 notice/evidence files are present and hash-verified
  in `u98Ls8` and diagnostic `2Q7LTB`. The four unresolved crate notices and
  exact linked-content review still leave the distribution gate open.
  Fresh-source engine builds now match across two build roots, all 57 generated
  files from six engines. Temporary compiler and bundle paths are normalized
  in the build rather than patched into a release. A fresh SDK package passed
  external-consumer checks, but was superseded by the final bridge cleanup fix
  before browser acceptance. This is source-build evidence, not release approval.
- [ ] TanStack.com release integration: the real Start Counter route passes the
  complete lifecycle through manifest `42799f37bd888a7888493cbd2efdf9f8a10688eacbfc74f45392005da2ebfcd7`
  and tarball `8febb9024b6dba8ae91d6768cd0fbb8c1ca20b0cd03b56a8732687533fbb94bb` in local
  integration mode. The site adapter remains opt-in during development and the
  package is still a local tarball. Publishing the package and enabling the
  released dependency are still open.
- [ ] Release: publish the free open-source alpha and verify its downloadable
  source, package, examples, and documented version. The reproducible npm
  tarball and publish dry run pass. Actual publication still needs npm
  authentication, a public source destination, complete notices, reproducible
  source-build instructions, and the unfinished actual Safari gate.
  Rechecked September 22: `npm whoami --registry=https://registry.npmjs.org`
  returns E401 outside the restricted sandbox. The user selected
  `https://github.com/tanstack/container` as the public source destination.
  The user confirmed that this is a planned repository, not an existing one.
  Repository creation and source publication remain release steps. No repository
  was created and no source was pushed. Recursive, untruncated GitHub tree listings at the
  three pinned revisions in `licenses/rolldown-rust-unresolved-notices.json`
  contain no license, copying, notice or copyright-named files. This confirms
  that looking below the repository roots does not recover the four missing
  crate notices. It does not establish exact linked contents or permission to
  omit notices. Do not mark the distribution review complete.

### Release artifact command

Ordinary SDK builds remain private `0.0.0` candidates. A public alpha build is
an explicit mode and refuses to run unless the repository has a regular root
`LICENSE` file, the version is an alpha semantic version and the declared
license is one of the supported SPDX identifiers. An explicit public HTTPS
source repository URL is also required. Its availability is verified separately
before publication, not inferred from the metadata format.
The publish dry run also compares the packaged `LICENSE` byte for byte with the
repository root `LICENSE`. The manifest and shipped-input notice record must
name the same SPDX identifier and SHA-256 hash. The alpha-only validator uses
the npm `alpha` dist-tag explicitly.

```sh
node scripts/source-snapshot.mjs . /path/outside/repository/web-container-source.tar.gz
SDK_RELEASE=1 \
SDK_RELEASE_VERSION=0.1.0-alpha.0 \
SDK_RELEASE_LICENSE=MIT \
SDK_RELEASE_REPOSITORY_URL=https://github.com/tanstack/container.git \
SDK_SOURCE_ARCHIVE=/path/outside/repository/web-container-source.tar.gz \
SDK_BUILD_PROFILE=<accepted-build-profile> \
SDK_ROLLDOWN_PARSER_ROOT=<portable-parser-directory> \
node scripts/build-sdk.mjs
# Use the SDK_OUTPUT path printed by the build, with the same release variables.
node scripts/validate-sdk-release-publish.mjs /path/printed/after/SDK_OUTPUT=
```

The repository URL above is the user-approved public source destination.
MIT is the approved project and package license. The version above still shows
the command shape and remains a release decision. Before publishing, choose the
alpha version, run the exact-artifact desktop and TanStack.com acceptance checks,
pack twice reproducibly, run the release-only npm publish dry run, and verify a
fresh registry install after publication.

The source command creates a deterministic archive and reports a
`sha256:<digest>` revision. It excludes dependencies, build output, generated
public assets, local toolchains, test results, reports, credentials and secret
files. The output must be outside the source tree. Keep that exact archive with
the release, rebuilding it after any source change.

After publication, save the registry's package metadata response and create the
external final attestation. This command does not publish or make a network
request. It fails unless the candidate has a verified source archive revision and the local
tarball, final manifest, package identity, license, registry version, dist-tag
and registry SHA-512 integrity all agree. The output path must not already
exist.

```sh
SDK_PUBLICATION_REGISTRY=https://registry.npmjs.org/ \
SDK_PUBLICATION_DIST_TAG=alpha \
SDK_SOURCE_ARCHIVE=/path/to/web-container-source.tar.gz \
node scripts/sdk-publication-attestation.mjs \
  /path/to/sdk /path/to/package.tgz /path/to/registry-metadata.json \
  /path/to/publication-attestation.json
```

Keep the resulting record beside the published tarball and acceptance evidence,
not inside the package whose manifest it binds.

## Acceptance evidence

### CTIzKR: repeated stock Firefox Start workflow

CTIzKR passes three fresh-profile stock Firefox runs, each covering cold start,
hydrated clicks, server functions, live edits, save/reload and offline dependency
resume. `scripts/check-native-start-batch.mjs` verifies the three reports against
manifest SHA256 `3d74305bcef7db11b69bc0afb1846a0de93ddcc2a8fe5f4e6ed670d46c6d936e`,
matching source hashes, lockfile and declared portable dependency substitutions.
It checks restored snapshot equality, zero compiler failures, process cleanup
and raw navigation evidence, not just report pass flags.

Reports: `reports/native-firefox-stock156-CTIzKR-repeat1.json`,
`-repeat2.json` and `-repeat3.json`. Each cold phase retains one fully witnessed
Vite reload cancellation; each resumed phase has none. These results do not
establish actual Safari support or complete Node compatibility.

CTIzKR also has nine persisted packaged install-cancellation results under
`test-results/sdk-install-cancellation-CTIzKR`: WorkerKernel cancellation,
AgentSession cancellation and independent concurrent-install cancellation in
Chromium, Firefox and WebKit. They verify preserved workspace and abort reason,
completed cleanup, then a successful three-package retry and execution.

The CTIzKR Chromium Start reports retain two console CSP errors per run:
Vite tries to create a reconnect SharedWorker after losing its preview socket.
The sequence is consistent with cold/resumed preview teardown, but the console
capture lacks timestamps, so this remains a lifecycle issue to verify and fix.
Keep `worker-src 'none'` intact. Passing interactions do not mean clean console
output. Evidence: `test-results/sdk-site-counter-CTIzKR-repeat`.

That six-run Chromium/WebKit batch completed successfully in 5.3 minutes,
three runs per engine. Each covers the real Start counter's cold and resumed
workflow. The separate packaged Vite/Start batch passed all twelve cases in
4.5 minutes under `test-results/sdk-framework-CTIzKR-repeat`. All saved reports
match the CTIzKR manifest, with zero page errors and no pending requests.

### ctCNtO: preview shutdown regression

Moving iframe removal before transport cleanup alone did not fix the issue:
FvDB8B still failed the browser regression with two reconnect-worker errors.
The page-hide WebSocket handler synchronously emitted an application close
event, allowing Vite to start reconnect work while the document was leaving.
Page-hide disposal now releases the transport without dispatching app events.
Normal live socket close/error events remain covered by four passing tests.
The existing twenty preview lifecycle tests also pass. CSP is unchanged.

The rebuilt ctCNtO passes one real Chromium Start cold/offline-resume cycle in
50.8 seconds with zero console errors, page errors or dependency requests on
resume, and acknowledged cleanup. Evidence:
`test-results/sdk-site-counter-ctCNtO-teardown`. Public API version 3, exports,
asset paths, hosting requirements and build profile remain compatible with
CTIzKR. Repeated Chromium/WebKit acceptance passes all six runs in 5.4 minutes
under `test-results/sdk-site-counter-ctCNtO-repeat`, with zero console/page
errors, no dependency requests on resume and acknowledged cleanup.
Three fresh-profile stock Firefox runs also pass, verified by
`scripts/check-native-start-batch.mjs` against manifest SHA256
`e3dba6c208f3739052436dcce3da7f1a47192187b7db3284eb5c81a07a830c80`.
Reports: `reports/native-firefox-stock156-ctCNtO-repeat1.json` through
`-repeat3.json`.

Packaged Start acceptance now exercises client navigation to `/about`, a direct
route reload returning HTTP 200 and client navigation home without reloading
the owner, both cold and offline-resumed. The initial test clicked a server
rendered link before hydration and failed its same-document assertion. Waiting
for observed Start hydration, without changing app code, passes the targeted
Chromium workflow in `test-results/sdk-framework-ctCNtO-navigation-ready`.
The repeated packaged batch passed six Chromium runs, then the first WebKit
Vite install stalled before a preview existed. The remaining five runs did not
run. Evidence: `test-results/sdk-framework-ctCNtO-navigation-ready-repeat`.
This remains an open reliability gate, not a successful repeated batch.

### HpZIUZ: install stream cancellation

Install cancellation now cancels pending download and decompression readers,
preserves the original abort reason and releases reader locks without waiting
for a stalled source cleanup promise. Workspace staging remains unchanged.
All 42 focused installer, cancellation and database unit tests pass. The new
artifact passes integrity verification, with 166 files and 52,825,002 bytes,
and remains compatible with ctCNtO at API version 3.
Manifest SHA256:
`31f3e49fa89bdba3fb60814dd7fad2ed9c8b68a1f10f3b49c8a706e3643d6d71`.

All nine packaged cancellation tests pass in Chromium, Playwright Firefox and
WebKit in 11 seconds: `test-results/sdk-install-cancellation-HpZIUZ`.
They cover WorkerKernel and AgentSession cleanup/retry and cancellation scoped
to a rejected concurrent install. These are not stock Firefox or actual Safari
acceptance runs, and do not establish that the WebKit install stall is fixed.

The packaged Vite workflow passes in WebKit on HpZIUZ. Start initially failed
because repeated owner `performance.timeOrigin` reads differed by 0.02 ms.
Navigation checks now use a per-document identity marker: client navigation
must retain it, explicit reload must replace it, and the owner must retain it.
Timestamps remain in the evidence but are not used as document identity.
The complete Start edit/test/preview/save/offline-resume workflow then passed
in 44.8 seconds, including both cold and resumed navigation checks. Evidence:
`test-results/sdk-framework-HpZIUZ-webkit` and
`test-results/sdk-framework-HpZIUZ-document-identity`. These single runs do not
close the repeated desktop gate.

A separate shared-counter diagnostic now distinguishes kernel timer execution
and heartbeat sends from owner message receipt, with owner and sibling-worker
timers as controls. It does not wrap native async APIs or change install limits.
The first run reached the Vite preview with all three timers advancing and
three heartbeats both sent and received, with no recorded errors:
`test-results/sdk-install-liveness-HpZIUZ`. This validates the witness on a
healthy run, not the cause of the intermittent stall. The instrumented worker
response is diagnostic evidence only, not release acceptance.
The second run also reached preview with no stall:
`test-results/sdk-install-liveness-HpZIUZ-second`. Stop repeating this witness
without a new hypothesis or a reproducing workload; the install stall remains
unresolved.

External package acceptance passes on HpZIUZ after updating two stale consumer
fixtures from API version 2 to the actual version 3. Exact version assertions
remain. Two independent packs have tarball SHA256
`f2d3cde8a098974544ad0a8a8dd4b572bd3af137c5b45ef15c8b558bc5ba5b96`.
Offline install/reinstall, public exports, copied runtime bytes, strict consumer
typechecks and a Vite production build pass without repository source imports.
The separate public type fixtures also pass in Bundler and NodeNext modes,
with `skipLibCheck=false` and no ambient package types. Commands:
`node scripts/test-sdk-package.mjs <HpZIUZ>` and
`node scripts/test-sdk-types.mjs <HpZIUZ>`. These checks do not publish or license
the package and do not replace browser acceptance.

### eLIjgK: compatibility guide included in the package

The README now links the shipped `COMPATIBILITY.md` instead of directing
adopters to an unavailable checklist. The guide separates historical artifact
results from current guarantees, names pinned example dependencies, and records
workflow limits, the unresolved install stall and actual Safari's unverified
status. Three README tests pass, including quickstart typechecking.

Artifact eLIjgK passes integrity and API version 3 compatibility verification:
167 files, 52,829,279 bytes, manifest SHA256
`f246add782624fc04cd96da1bb660a686e057e3ac3a56884ad0f5846ea40b6f4`.
Only README, COMPATIBILITY, shipped-input notices and size-report records differ
from HpZIUZ; runtime bytes are unchanged. External package acceptance passes,
including reproducible tarball SHA256
`3f03e32dc5e5d0f95c6668f8c62808e8fc39c9f09c860f3648019d8b95732c2e`,
offline install/reinstall, public types and a consumer Vite build.

Repeated packaged acceptance on this manifest stopped at the first failure:
all six Chromium workflows and the first four WebKit workflows passed; the
third WebKit Vite run stalled during install for 60 seconds, and the last
Start run did not run. Evidence: `test-results/sdk-framework-eLIjgK-repeat`.
This is 10 passed, 1 failed and 1 not run, not a release pass.
Unlike the earlier four-download stall, this failed install recorded 27
requested and finished tarballs, with the last finishing at 1,443 ms. There
were no pending requests or recorded page/HTTP/request errors, and the UI still
showed installation. This rules out treating the four-package fixture as an
adequate reproduction. The next isolated check must use the full pinned
project through the actual installer, separating it from kernel/VM startup.

### Agent resource acquisition cancellation

Cancelling an AgentSession file operation or run while its handle was still
being created could discard the eventual handle without cleanup. Acquisition
now retains ownership: a late file session closes, or a late process is killed
and disposed, before cancellation rejects with its original reason. Pre-aborted
calls acquire nothing; queued file mutations wait for cleanup. Public API and
resource limits are unchanged.

Six new delayed-acquisition tests and five existing agent tests pass, as does
TypeScript checking. Reinstating the old acquisition behavior failed four
cases, then restoring the fix passed all eleven. If acquisition or cleanup
never settles, cancellation remains pending rather than abandoning the handle.
This change is not included in eLIjgK. It is packaged in vnNp8D, which passes
integrity and API version 3 compatibility checks: 167 files, 52,829,893 bytes,
manifest SHA256
`ed1ecbef63e914b40ac41ded7a7968679ea05279c4897c36bdf0014d7c56b9a0`.
Two regression tests import the built public SDK and verify late file cleanup
and process kill/disposal before cancellation settles. Both pass on vnNp8D and
fail on eLIjgK. External package acceptance now runs these tests against the
installed tarball, and passes with reproducible tarball SHA256
`3507217e6e6bf73eebf626f689a7115ed87f3670ef486edd1cdef9aa7cfe985f`.

### Full installer without kernel startup

`tests/sdk/install-full.spec.mjs` loads the complete pinned Vite example,
including its example test files, and runs the real `installProject` in a plain
worker with the same workspace limits and cache behavior. It does not start the
SDK kernel, VM or app server, or wrap native async APIs. Source, project, lock
and worker hashes accompany shared liveness counters and network records.

The first WebKit run installs all 48 supported packages in about 2.3 seconds,
preserves the lock, and produces 781 files totaling 25,037,650 bytes. Owner and
worker counters advance; errors and pending requests are empty. Evidence:
`test-results/sdk-install-full-vnNp8D`. This broadens the reproduction beyond
the first four packages, but one healthy source-installer run does not rule out
an intermittent installer issue or establish packaged app compatibility.
The second full-installer comparison also passes in 2.4 seconds:
`test-results/sdk-install-full-vnNp8D-second`. Stop repeating this comparison
without new evidence.

An unchanged-runtime diagnostic now samples at most two verified descendants
of its own launched WebKit process, for two seconds each, only after an install
failure. It checks process identity and ancestry before sampling and records
unavailable ownership rather than inspecting unrelated processes. Two ownership
tests pass. Its first normal packaged Vite install passes in 6.8 seconds, so no
native stack sample was collected: `test-results/sdk-install-owned-profile-vnNp8D`.
The stall remains unresolved; no timer, install limit or runtime response was
changed. Actual Safari remains a necessary independent check, awaiting the
user's remote-automation setting. License and production preview-origin choices
have also been requested; no settings or deployment were changed.

The second single-install failure-sampling run also passed, so those isolated
repeats stopped. `SDK_OWNED_PROFILE=1` now adds failure-only sampling to the full
packaged framework workflow, retaining its install/edit/test/save/resume steps,
context defaults and timeouts. Without that flag the original browser fixture
is used. Diagnostic reports identify themselves explicitly.
All six WebKit workflows pass in 2.7 minutes on vnNp8D in this mode:
`test-results/sdk-framework-vnNp8D-owned-profile`. Page errors and pending
requests are empty. No native samples were collected because nothing failed.
These are diagnostic-mode results, not evidence that the intermittent stall
was fixed or that actual Safari passed.

### n7s2Jb: cancelled restores do not dispatch

An already-cancelled or queued-then-cancelled AgentSession restore could still
decode its snapshot and dispatch to the kernel. Restore now checks its signal
at the start of the queued operation. Four new tests verify unchanged files,
no snapshot reads or dispatch on cancellation, later queue usability and normal
error behavior. All 15 related tests and TypeScript checking pass.

The packaged pre-aborted restore regression fails on vnNp8D and passes on
n7s2Jb. All three packaged cancellation regressions now run during external
package acceptance. That acceptance, integrity verification and API version 3
compatibility pass: 167 files, 52,829,920 bytes, manifest SHA256
`86f90836668ff77c56a00ed3f9b316333268f1440f264ec82ed4d6a755dc0ff7`,
reproducible tarball SHA256
`d340b82a3149ec157fab8b93c71394a436f38e07dfd1813bbbc6ffca86db1b21`.
Three fresh-profile stock Firefox 156.0 real Start cold/offline-resume runs now
pass on this manifest. `scripts/check-native-start-batch.mjs` verifies distinct
profiles, identical source and dependency provenance, matching saved/restored
workspace fingerprints, no dependency downloads on resume, no unclassified
preview errors and acknowledged cleanup. Each cold phase retains one verified
navigation cancellation; each resumed phase has none. Evidence:
`reports/native-firefox-stock156-n7s2Jb-repeat1.json` through `-repeat3.json`.
This proves the pinned real Start workflow in stock Firefox, not actual Safari
or resolution of the separate intermittent WebKit package-install stall.
Three matching real Start Chromium cold/offline-resume runs also pass in 2.3
minutes: `test-results/sdk-site-counter-n7s2Jb-chromium`. Independent report
checks confirm exact candidate manifests, complete cold/resumed interaction and
edits, identical saved/restored fingerprints (6,820 files, 121,736,719 bytes),
no offline external requests, zero page/console errors, zero failed parser
callbacks and acknowledged cleanup. Each console report has eight entries,
below its 32-entry cap. The same current artifact therefore has three verified
real Start runs each in Chromium and stock Firefox. Actual Safari, the separate
WebKit install stall, project licensing and production site integration remain
open.

The final full-workflow profiling batch passes all six WebKit runs in 2.7
minutes on n7s2Jb: `test-results/sdk-framework-n7s2Jb-owned-profile`.
All six observation reports say passed, have no pending requests and record
that no native sample was requested. This uses the diagnostic browser-launch
fixture, not normal release acceptance. Two full profiling batches have now
passed without reproducing the stall. Stop this experiment family; the stall
and actual Safari acceptance remain open.

Virtual port discovery is now implemented in source. `subscribePorts` replays
current opens and returns an unsubscribe function; `listeningPorts` returns a
sorted copy. First-listener-open and last-listener-close transitions cover
ephemeral ports, shared listeners and process cleanup. Kernel shutdown closes
known ports and drops subscriptions. Observer failures cannot interrupt cleanup.
The framework example now discovers the port instead of parsing `APP_READY`
or hardcoding the preview port, while draining process output separately.
The packaged example includes and serves its startup helper. A listening port
is not proof of HTTP readiness; existing preview checks remain necessary.
Network, owner API and install cancellation suites pass 30 tests; example and
README suites pass 13 tests. TypeScript checking passes. These source changes
still need a fresh package build and full browser workflow verification before
they can inherit any artifact-level compatibility evidence above.

### Port discovery: packaged workflows and API version 4

XTDpbz passes all twelve normal packaged framework workflows, three runs per
app in Chromium and WebKit, in 5.0 minutes:
`test-results/sdk-framework-XTDpbz-ports`. This is not the profiling fixture.
Its manifest SHA256 is
`7ca18fb34bce57b212b8ce7a71610c9996f613a457ba9fa5a0c94fb092a3edd1`.
This intermediate package still used API version 3. The contract comparator
requires a version change for the expanded WorkerKernel shape, so source and
external consumer fixtures now require version 4. Contract tests pass without
relaxing that rule.

The version-4 package ZOgz1m has manifest SHA256
`455cde2693f92906b8e6abcd179bc4b18265a93626f903275e3b3dcf861c8fc8`.
Its silent ephemeral-server acceptance test passes once in Chromium,
Playwright Firefox and WebKit: `test-results/sdk-port-discovery-ZOgz1m`.
Each run starts two HTTP servers sequentially without a ready log message,
discovers their assigned ports, fetches through WorkerHTTP, verifies late
subscription replay and unsubscribe, and observes disposal close each port.
This verifies the real worker transport, not just a mocked owner. It does not
replace complete framework workflows on this exact package or actual Safari.
External package acceptance also passes on ZOgz1m: reproducible pack, offline
install and reinstall, strict consumer types including port events, consumer
Vite build and all three packaged cancellation regressions. The tarball SHA256
is `e936f3c173a55cfd6bb24d9b9b03d74f133c78c37d255df606d97dc610420b83`
(168 files, 52,835,115 bytes).

The full normal ZOgz1m batch does not pass: eight workflows passed, the second
WebKit Vite install timed out at the unchanged 60-second preview assertion,
and three workflows did not run. Evidence:
`test-results/sdk-framework-ZOgz1m-ports`. The page snapshot still says
"Installing dependencies". Eight registry archives were requested, seven
finished, and `@vitest/runner` remained pending. The last observed network
event was at 595 ms. The final output read returned null and observed page
errors were empty. This does not prove a crash, a registry fault or a specific
installer cause. It occurred before server startup and port discovery.
Do not retry this batch simply to obtain a pass. The earlier XTDpbz pass does
not satisfy repeatability for the current package.

`scripts/check-framework-batch.mjs` now validates paired success/observation
reports against the exact package and the twelve-run framework/browser matrix.
It rejects missing, duplicate, failed, wrong-artifact and diagnostic reports,
checks observed errors and pending requests, and validates Start navigation
across cold and resumed documents. Its three tests cover negative evidence,
and it accepts the complete XTDpbz batch. It explicitly does not claim Safari
or console-error coverage.

ZOgz1m passes three fresh-profile stock Firefox 156.0 real Start cold/offline
resume runs. Reports are `reports/native-firefox-stock156-ZOgz1m-repeat1.json`
through `-repeat3.json`. The native batch verifier confirms the exact manifest,
source/lock provenance, distinct profiles, matching workspace fingerprints,
no offline dependency requests, no unclassified errors and cleanup acknowledgement.
The packaged declarations also pass strict external Bundler and NodeNext
consumer checks, without ambient package types or source-tree imports.

The next bounded diagnostic uses `SDK_STANDARD_PROFILE=1`, which preserves
Playwright's normal browser fixture. Before each WebKit test it records the
current test worker's process identity. Only after a failure does it sample
at most two verified WebKit descendants inside that browser's executable
directory, for two seconds each, rechecking identity and ancestry immediately
before each sample. Reparented or unrelated processes are excluded. Reports
are diagnostic-only, and this mode cannot combine with the launchServer mode.
Seven ownership tests pass. The first batch uses
`test-results/sdk-framework-ZOgz1m-standard-profile`. Stop after at most two
batches without evidence that changes the next action; do not restart the
earlier launchServer profiling family.

The first normal-launch diagnostic batch reproduced the failure: eight passed,
the second WebKit Vite workflow failed during install, and three did not run.
Its failure report retained the install-status text, zero observed page errors
and no pending requests. All 26 requested registry archives finished, with the
last network event at 1,428 ms. Ownership capture identified the test worker,
but no qualifying owned WebKit content processes could be verified, so no
stacks were sampled. This does not identify the failing installer operation.
Stop this profiling family now rather than spend its optional second batch on
the same unavailable observation. Existing isolation and ownership checks stay
unchanged. Actual Safari is still needed as an independent browser check.

Upstream reports [42385](https://github.com/microsoft/playwright/issues/42385)
and [42273](https://github.com/microsoft/playwright/issues/42273) describe
navigation/reload hangs with different triggers. Neither establishes the cause
of this install-stage stall, so no runtime workaround is based on them.

Current ZOgz1m Start/Vite 8 verification in
`test-results/sdk-site-counter-ZOgz1m-repeat` passes all six runs in 5.3 minutes:
Chromium and WebKit repeats 0, 1 and 2. The process exited successfully. Each report matches the exact
package manifest and delivered engine hashes, completes all 15 workflow stages,
restores the saved workspace fingerprint, and records no offline dependency
requests, page errors, failed requests or pending requests. Final kernel
shutdown is acknowledged. The resumed resource snapshot is captured before
cleanup, so it does not prove a zero final process count. This is not actual
Safari evidence, and it
does not resolve the separate packaged-framework install stall.

### Firefox repeat exposed unrelated parse rejection

P9oyFi repeat 1 passes cold/offline resume in 69.734 seconds. Repeat 2 returns
HTTP 500 on its first server-function update: `Nested native calls from
callbacks are unsupported`, with one native parser failure. The batch stops;
repeat 3 is not run. Reports are
`reports/native-firefox-stock156-P9oyFi-repeat1.json` and `-repeat2.json`.

The parser used a global pending-callback count to reject all incoming calls.
The fix carries the existing guest callback ownership through the parser
adapter and validates it before admission. Unrelated parses wait in the
existing bounded native queue; callback-owned reentry still rejects. Source
size, pending-count and deadline limits remain unchanged. Twenty focused
runtime/unit checks and three actual QuickJS adapter tests pass. Full
TypeScript checking passes after adding the adapter declaration.

Candidate CTIzKR includes this fix and scoped install cancellation. Its
artifact verification passes for 166 files, 52,824,358 bytes and six preview
routes. The release-policy check finds no API/profile/hosting change from
P9oyFi, keeping API version 3. Manifest SHA256:
`3d74305bcef7db11b69bc0afb1846a0de93ddcc2a8fe5f4e6ed670d46c6d936e`.
Full browser repeats of this candidate remain pending.

### Stock Firefox cold start and offline resume

`reports/native-firefox-stock156-elFo1R-causal.json` passes in 70.065 seconds:
SSR, hydration, counter clicks, HMR, persisted server count, snapshot save,
fresh-owner reload and offline restore all pass within unchanged deadlines.
The snapshot restores exactly: 6,820 files, 121,736,271 bytes, 6,804 package
files and 26 cache files. Both kernels acknowledge shutdown. Owner errors,
compiler failures and offline CSP violations are zero.

One cold dynamic-import error is retained as a navigation cancellation, not
discarded. Classification requires a matching old document, Vite full-reload,
an import in flight during navigation, completed HTTP 200 bodies for the exact
URL in both documents, and a hydrated replacement document. Errors lacking any
witness remain fatal. The causal interval avoids exact equality between two
clocks. The resume has no preview errors. Earlier unclassified failures remain
in `native-firefox-stock156-elFo1R-first.json`, `-document-events.json` and
`-classified.json`. Six harness tests cover the classifier and negative cases.
This pass uses elFo1R, not the newer P9oyFi artifact or actual Safari.

### Packaged WebKit repeats

On elFo1R, `test-results/sdk-framework-packaged-webkit-repeat` passes three
Start workflows and two Vite workflows. The third Vite run times out during
dependency installation, before a preview exists. Three targeted follow-ups
pass in 28.1 seconds at `test-results/sdk-framework-vite-webkit-install-observations`.
The original stall remains unexplained. The harness now persists bounded
network events, pending requests, page errors and output, verified by
`test-results/sdk-framework-vite-webkit-persisted-observations`.
No runtime limits or deadlines changed. WebKit is not actual Safari.

### Installation cancellation reaches the worker

`WorkerKernel.install(options, signal)` now forwards cancellation to the worker
and waits for staged installation cleanup. `AgentSession.install` uses that
contract instead of merely abandoning its wait, so queued mutations do not
race a still-running install. Already-aborted requests do not start an install.
The original workspace survives cancellation and a subsequent install succeeds.
Nine focused unit tests and TypeScript checking pass. All 21 install regression
cases pass across Chromium, Firefox and WebKit in
`test-results/install-cancellation-full-regression`, including signal-driven
worker and agent cancellation while package responses are held, followed by
reinstallation and execution. Cancellation itself is verified against the
source runtime. The rebuilt TNDHRh SDK passes both packaged Vite and Start
Chromium workflows in 41.6 seconds (`test-results/sdk-framework-TNDHRh-chromium`).
Its declarations include the new optional signal. Artifact verification passes:
166 files, 52,810,969 bytes, six preview routes, manifest SHA256
`4d9ff7a5a388631d3ba4f868fd34c4d493d8f1fad4db0b300baf02514e15c7eb`.
Repeated desktop acceptance of this new artifact remains open.
The API comparison defect is fixed: public inherited instance/static members
and inherited constructors are now included, with private/protected members
excluded. Six contract and release-policy tests pass. The new install signal
is detected through the `WorkerKernel` facade. API version is now 3 under the
existing conservative policy. Candidate P9oyFi passes artifact verification
(166 files, 52,823,672 bytes, six preview routes) and the version-policy check
against elFo1R. Its manifest SHA256 is
`36fdb83710acd0e89aa30504cd7e79f623fe7c93517a51c6b4c21815fa823352`.
P9oyFi browser acceptance remains pending; TNDHRh results are not automatically
transferred to this newer artifact.

P9oyFi's packaged cancellation checks subsequently pass six of six cases in
Chromium, Firefox and WebKit (`test-results/sdk-install-cancellation-packaged`).
Both public APIs reject only after worker cleanup while fixture downloads are
still held, preserve the full workspace and successfully retry and execute.
This verifies cancellation, not the complete app acceptance gate.
The later source fix gives each install a cancellation token so an older abort
cannot cancel a newer install, and reports success when the worker already
committed before cancellation. Ten focused agent/cancellation tests pass.

The first Chromium signal test exposed a separate lab-host reload. Its trace
records Vite `full-reload` while the worker discovers `semver`. Adding that
existing dependency to the lab's explicit prebundle list fixes the reload;
the six targeted signal cases and subsequent 21-case suite pass. This does not
establish the cause of the earlier packaged WebKit installation stall.

### Packaged script workflows on elFo1R

`test-results/sdk-framework-packaged-script-final` passes both Vite and Start in
Chromium using only the packaged examples, no source overlay. Vite takes 6.3
seconds and Start 33.4 seconds. Each installs its pinned graph, runs a real test,
fails after an edit, passes after repair, saves and reloads, then runs the test
again with external dependency requests blocked. Start also verifies hydrated
interaction and a server-function response. Both rendered examples were inspected.
`test-results/sdk-shell-allocation-stderr` passes the rejected-allocation error
regression. The app uses 128 MiB, worker ceiling 64 MiB and aggregate cap remains
512 MiB. These are single Chromium passes, not repeated desktop certification.
Artifact verification passes for 166 files, 52,810,192 bytes and six preview
routes. Manifest SHA256:
`86111068900b125b3c3594c82faf1cf87dc9d14f2dd43577815f61a8d9e45145`.
The debugger-free native Firefox acceptance is running next on this artifact.

The first direct Firefox launch, recorded in
`reports/native-firefox-start-elFo1R-first.json`, reached installation and SSR,
then failed the unchanged hydration deadline. It is not stock Firefox evidence:
the Playwright-supplied binary registers Juggler frame actors and worker
debuggers even without an automation connection. Its stderr confirms Juggler
loaded. Neither system nor user Applications contains stock Firefox. The native
harness must reject known patched builds before running, and a separately
verified official Mozilla build is needed for ordinary Firefox evidence.

### Standalone example persistence and Firefox startup follow-up

Both standalone example hosts now keep stable origins by default: basic uses
4173/4174 and frameworks uses 4175/4176. `OWNER_PORT` and `PREVIEW_PORT` select
other ports; automation explicitly selects zero for temporary ports. Busy ports
fail rather than silently hiding saved IndexedDB workspaces under another origin.
The packaged examples include the standalone port helper. Focused host and
framework-example tests pass 12/12, including validation, conflict handling and
port reuse after shutdown. This is host behavior evidence, not a new browser
workflow pass or a newly built release artifact.

`test-results/sdk-site-counter-firefox-assignments-http` still fails readiness
on candidate MbZVp1 in 56.2 seconds. Owner-side HTTP timing records the second
Start stylesheet request awaiting headers at the preview deadline after an
optimizer reload. Static preview scripts complete in about three milliseconds.
This narrows the next investigation to guest request/compiler scheduling; it
does not establish the root cause or justify increasing the timeout.

The next Firefox diagnostic must capture totals after `await child.dispose()`
and before closing the kernel. Runtime totals are emitted during process
completion; kernel shutdown alone does not wait for that completion. Use the
existing diagnostics flag, not `profileJobs`, which changes job batches from
100 to one. Capture `hostTaskScheduling` separately from the top-100 job profile.
Do not change app readiness deadlines for this diagnostic.

The post-disposal run in `test-results/sdk-site-counter-firefox-terminal-timing`
fails readiness in 57.6 seconds but captures complete main-process totals.
Main-guest fiber execution consumes 37.474 seconds, with no parked steps and a
5.988-second maximum step. Inclusive native WASM calls total 4.108 seconds and
CommonJS compilation about 1.2 seconds. A step may contain up to 100 jobs.
Keep the scheduler unchanged: existing fairness yields retain the guest engine
lock and cannot establish a startup throughput fix. Firefox Start remains an
unresolved guest-engine throughput gap. CPU stack attribution, not another
aggregate timing rerun or a larger deadline, is needed to choose an optimization.

The standalone framework example now exposes live package scripts through public
`runShell`, with bounded execution and exit status. Example-only tests exercise
the Vite message module and HTTP SSR from the running Start app. Pinned dependency
graphs are unchanged. The Chromium pass/fail/repair/offline-resume browser check
in `test-results/sdk-framework-script-workflow` finished with both cases failing;
it used current example source with MbZVp1, not a newly packaged release.
Vite reached the test but `node:test` named import was undefined: its callable
default lacked the named API properties required by the builtin module bridge.
The source fix adds those properties, passes three regression tests and has
regenerated kernel builtins. A rebuilt SDK and browser rerun remain required.
Start failed earlier with a Babel parser stack overflow under the example's
non-fiber configuration, before script execution. Neither example's full test
workflow was accepted by that run.

Rebuilt candidate AzETvc includes the callable `node:test` export fix and passes
artifact verification (165 files, 52,806,668 bytes, six preview routes).
`test-results/sdk-framework-script-vite-fixed` passes the packaged standalone
Vite example in Chromium: a real script passes, fails after source editing,
passes after repair and passes after offline workspace resume. The rendered
example was inspected. This is one Chromium run, not a desktop compatibility
claim. Start's updated example now explicitly selects the engine declared by
the SDK manifest and requires the corresponding owner isolation headers; its
browser verification remains in progress.

`test-results/sdk-framework-script-start-engine` verifies the manifest-selected
fiber engine gets the standalone Start example through hydration, a counter
click and a server-function response. It then fails because the first HTTP test
returns status one without TAP or error output. The full script workflow remains
open. Unchanged editor contents are no longer written before running a script,
avoiding needless HMR; eight focused example tests pass.

Firefox CPU capture `/private/tmp/start-firefox-profile.2OsONE/profile.json`
contains startup-through-shutdown worker samples. QuickJS interpreter
`JS_CallInternal` accounts for 17.739 seconds exclusive and 37.948 seconds
inclusive CPU; inclusive numbers overlap. All named engine samples are in the
baseline WASM tier. Installed Playwright Juggler creates worker Debugger objects
without `allowUnobservedWasm`, which Mozilla's debugger defaults to false and
which disables optimizing WASM compilation. Normal DevTools explicitly opts out.
Do not patch the SDK or installed browser to compensate. A debugger-free native
Firefox acceptance harness is being implemented with the same app and SDK,
preserving resource limits, preview separation, deadlines and offline restore.
Until that runs, normal Firefox Start compatibility remains unverified.

After the interrupted turn, both agents confirmed no old browser process needed
restarting. The standalone script investigation resumed with a bounded Chromium
probe of the raw shell error and resource state. Nineteen current example,
host-lifecycle and public quickstart checks pass. This does not resolve the
Start script failure or establish native Firefox support.

The raw shell probe confirmed the Start script admission failure: two active
processes reserved 536,870,912 bytes, and the test requested another 16,777,216.
The example's inherited fork allocation, not merely worker-thread allocation,
used the remaining budget. The example now explicitly starts its app with
128 MiB, retains its owner ceiling and 64 MiB worker allocation, and keeps the
512 MiB aggregate cap. Full acceptance is still required to validate that budget.
The Go shell now prints non-exit-status failures to stderr. Its pinned Go 1.27.1
toolchain was restored from the official checksum-verified archive under
`.toolchains/mvdan-go-1.27.1.CJ1qOr`; locked Go modules were downloaded, then the
shell rebuilt offline. The shell build requires an explicit toolchain argument
or `MVDAN_TOOLCHAIN`, no deleted temporary path is assumed.
SDK candidate elFo1R includes these fixes and the manifest-aware example host.
The packaged framework and shell rejection regressions are next.

The MbZVp1 repeatability run is tracked in
`test-results/sdk-site-counter-assignments-repeat-resume`, three sequential
cold/resume checks each for Chromium and WebKit. All three Chromium checks passed
in 47.7, 47.3 and 47.4 seconds. Each records identical saved/restored fingerprints,
zero external dependency requests, zero browser diagnostics, zero failed compiler
callbacks and acknowledged shutdown. All three WebKit checks also passed.
The suite terminated successfully with 6/6 passes in 5.5 minutes. All six
diagnostic files confirm matching restored fingerprints, zero external
dependency requests, zero browser/compiler errors and acknowledged shutdown.
This establishes three cold/resume runs per Chromium and WebKit on MbZVp1,
not Firefox or actual Safari support.
Resume diagnostics now retain the actual restored fingerprint as well as the
saved fingerprint. TypeScript checking passes.

The current TanStack.com integration checkout is
`/Users/tannerlinsley/GitHub/tanstack.com`; the previously referenced `a111`
worktree is absent. Read-only inspection confirms `example-webcontainer.client.ts`
still uses `@webcontainer/api`. The first SDK integration needs an explicit
SDK-owned preview container in `ExampleWorkbench.client.tsx`, a public-SDK-only
session adapter, a pinned project command/virtual port and separately hosted
preview assets. Preserve the existing WebContainer path for other examples.
Server-ready events, arbitrary preview-script injection and terminal resizing
are not drop-in SDK contracts. Do not silently emulate unsupported controls.
No site changes or deployment have been made.

### Assignment-parser SDK: real Start in WebKit

Candidate `browser-sandbox-sdk-MbZVp1` passes the real Start counter in WebKit
in 35.9 seconds. Evidence is in
`test-results/sdk-site-counter-webkit-assignments`. The test covers registry
installation, SSR, hydrated interaction, persisted server-function results,
route live edits without a host reload, and another interaction after editing.
It reports 2,377 completed callable operations, zero failed callable operations,
no browser diagnostics and acknowledged kernel shutdown. Artifact verification
passes for 162 files, 52,798,268 bytes and six preview routes.
This is one cold workflow, not repeated runs, resume or actual Safari evidence.

The follow-up `test-results/sdk-site-counter-webkit-assignments-resume` also
passes in about one minute. It reloads the host, restores a persisted snapshot
into a fresh kernel without installation, and repeats interaction and live edits.
The restored fingerprint matches 6,820 files and 121,736,719 bytes, including
6,804 package files and 26 cache files. This adds one WebKit resume pass, not
repeated-run or actual Safari evidence. Owner SDK assets remain online.

AZH3Yl passes the full Start cold/edit/save/reload/resume workflow on Chromium
in46.6seconds (`test-results/sdk-site-counter-offline-resume`). The public
snapshot restores into a fresh kernel before spawning, without another install.
Fingerprints match for6820files (121736719bytes), including6804package files
and26Vite cache files, plus directories, modes and symlink metadata. Counter
state2 and its edited route survive; resumed interactions advance it to4 with
another live route edit. There are zero attempted external dependency requests,
zero failed callable operations in both runs, zero page errors and acknowledged
shutdown. This proves offline workspace/dependency restore, not offline hosting,
live-process restoration or reuse of the saved compiler cache at runtime.
One cycle is not the required repeated desktop acceptance.
Snapshot-helper browser reload checks independently pass in Chromium, Firefox
and WebKit (`test-results/start-workspace-persistence`); they are not full-app
compatibility evidence.

Candidate `browser-sandbox-sdk-AZH3Yl` passes the current real Start workflow
cleanly on Chromium in28.7seconds: SSR, hydrated counter interaction, server
function persistence, route live edit and interaction after the edit. There
are2377completed callable operations, zero failed callbacks, zero page errors
and acknowledged shutdown. Evidence: `test-results/sdk-site-counter-watch-events`.
This is one run with the declared portable dependency graph, not repeated
desktop or save/resume acceptance.
Firefox on the same AZH3Yl package still fails within the original startup
budget. Per-document observation confirms the reloaded page receives its
bootstrap and completes its SSR stream, but does not hydrate. The client-entry
dynamic import is aborted. This rules out treating the prior failure solely
as an overly strict load-event gate. Compiler watcher failures are zero.
The initial WebKit standalone/nested Babel compile probes pass, so the simple
assignment-parser hypothesis does not justify an engine change. The next probe
must reproduce the production native job-drain entry path.
That WebKit native job-drain probe also passes unchanged Babel compilation at
depths0and4. Further guessed nesting probes are not justified; capture the
actual full-app compilation failure instead.
The full WebKit run with existing runtime diagnostics identifies the actual
failure: host compilation of Babel's generated `uppercase.js` exhausts the
native parser stack in repeated `js_parse_assign_expr2` frames. Evidence:
`test-results/sdk-site-counter-webkit-host-stack`. This supports composing the
existing iterative-assignment parser stage into a new explicitly named engine
profile, preserving old artifacts and the same resource limits. The small
passing probes did not reproduce the full app's native stack conditions.
Firefox timing rules out slow injected preview scripts: both finish by123ms,
while the reloaded document reaches its bootstrap at18.78seconds. The pending
stylesheet and module graph need owner-side HTTP timing because Firefox's
service-worker resource timing does not report their duration. Evidence:
`test-results/sdk-site-counter-firefox-timing`.
Save/resume acceptance helpers now preserve public binary snapshots through
IndexedDB structured clone and fingerprint file contents, paths, directories,
symlinks and modes. Two fingerprint unit tests and TypeScript pass. A real
browser reload test is prepared but not yet run; these helpers are not yet
integrated into the full Start acceptance test and prove no app resume claim.

Candidate `browser-sandbox-sdk-6ZfUs4` passes the full current Start counter test
on Chromium in27.7seconds with its declared portable dependency graph. Evidence:
`test-results/sdk-site-counter-scoped-admission`. The test verifies counter0→1,
route label edit without host reload, counter1→2 and persisted count.txt2.
No failed/pending browser requests or page errors remain; cleanup is acknowledged.
Server output still reports unsupported create/update watch events, with
2369completed and8failed callable operations. Resolve those instead of treating
the green interaction test as a clean release pass. Save/resume and actual
Safari remain unverified for this candidate.
The same6ZfUs4 candidate fails the first Firefox and WebKit full Start checks
(`test-results/sdk-site-counter-scoped-admission-desktop`). Firefox exhausts
the existing preview startup budget waiting for load after optimizer reloads,
with an aborted client import. WebKit fails earlier while compiling Babel
through nested CommonJS loads. Neither is a desktop compatibility pass.
Create/update/delete callable watcher mirroring is now implemented and focused
tests pass; the next packaged interaction run must also report zero failed
compiler callbacks. Real app assertions now enforce that condition.

Current preview candidate `browser-sandbox-sdk-EDB1zs` passes the package
verifier (162 files, 52,795,212 bytes) and all 21 packaged preview cases across
Chromium, Firefox and WebKit. The hosting fix supplies COEP consistently and
CORP for intended cross-origin document embedding, without widening ordinary
guest fetch permissions. Evidence: `test-results/sdk-preview-embedder-corp-verified`.
Firefox retains an unexplained service-worker console diagnostic despite
successful document, redirect, fetch and inspection checks. This is not yet
a full Start app compatibility pass or actual Safari evidence.

The EDB1zs Start run reaches SSR and preview mounting without the previous
`ERR_BLOCKED_BY_RESPONSE`. It still times out: Vite reports an unsupported
nested native callable invocation, followed by guest Rolldown worker creation
failing at the existing resource limit. Shared bundling completes and shutdown
is acknowledged. Evidence: `test-results/sdk-site-counter-preview-coep`.
Resolve the callback and remaining guest-compiler paths before claiming
hydration or increasing the workflow coverage.
The callable guard now uses callback ownership carried by a separate ALS
instance, rather than rejecting all calls while any callback is pending.
Six dispatch/actual-QuickJS checks and TypeScript pass. They cover unrelated
overlap, rejection of active callback reentry and admission after the callback
reply. Packaged Start verification of this change remains pending.
The adapter also has a confirmed offload gap for `builtin:oxc-runtime` and
`builtin:vite-json`; the prior stack does not identify which one exhausted
guest workers. Route both through the existing shared compiler and verify
native parity before the next full-app run.
Candidate `browser-sandbox-sdk-H4BJvo` includes both fixes and passes package
verification. The real Start run now mounts and renders the initial button
without the prior callback error or worker panic. Its first click does not
produce the expected updated count within the existing assertion deadline;
four client module requests remain pending. Evidence:
`test-results/sdk-site-counter-shared-client-plugins`. Check client readiness
before classifying this as a server-function failure. Hydration is not proven.
Readiness checks now wait for document loading and the pinned Start hydration
wrapper signal within the same 30-second preview startup budget. The latter
means settlement, not success; single-click counter assertions remain required.
`test-results/sdk-site-counter-start-ready` exposes the next actual failure:
ordinary client import fanout hits `Guest callable operation limit`, causing
dynamic module loading to fail. Diagnose admission/backpressure and lifecycle
under the existing limits before another full-app run.
Compiler admission now uses a bounded FIFO for bursts instead of rejecting at
64 outstanding calls. Active capacity remains 64; queued and active input
reservations share the previous aggregate byte ceiling, with a minimum
256-byte charge per entry and at most 1024 waiting entries. This is transport
backpressure, not serialization of the whole app. Node and actual QuickJS
burst/ALS checks pass. Review identified a nested-bundler dependency requiring
one of those 64 credits to remain available for scoped work. That scheduling
regression now passes in actual QuickJS, including preserved ALS and cleanup.
The UI3jie test run stopped at a test-only live-DOM bootstrap assertion.
The absence of a script node alone does not establish that its source was
never delivered. Readiness validation now checks the actual delivered
document response. Evidence: `test-results/sdk-site-counter-callable-admission`.
This run does not establish hydration success or validate the admission fix
under the complete application workload.

Record the SDK manifest hash, dependency lockfiles, browser versions, operating
system, test command and raw results for every release candidate. Run at least
three fresh cold/resume cycles per desktop browser for each representative app.
Keep the existing assertions, workload and deadlines; retries are not passes.

The app checks must exercise browser behavior, not just HTTP 200: hydrated
interaction, a server-function round trip, and an edit visible in the preview.
Resume must use persisted files after a real host-page reload and a fresh
runtime, preserving project changes. State whether dependencies were restored
from the saved workspace or fetched again.

## Scope and guarantees

Common JavaScript and TypeScript projects are the target, not complete Node or
operating-system compatibility. Phones, native addons, arbitrary binaries and
uncommon framework features are outside this gate.

Retain existing permission checks, isolation boundaries, cancellation and
resource accounting. Describe their actual scope in release docs. Functional
tests do not establish production security or unrestricted safe execution of
arbitrary untrusted projects. Do not resume adversarial experiments as a
prerequisite for this alpha.

## Current candidate evidence

- Candidate eE4MgP fixes the circular named-import re-export binding in QuickJS.
  The exact RouterCore call now matches Node, and nine module semantics cases
  plus 67 engine/profile checks pass. The packaged SDK passes all 21 fiber
  checks in Chromium, Firefox and Playwright WebKit, including a circular
  callable export and its live replacement from 42 to 43. Evidence:
  `test-results/sdk-fibers-module-exports`. This is not actual Safari evidence
  or full Start acceptance. The candidate uses a separate engine artifact and
  leaves resource limits and application source unchanged.
  The unchanged full Start counter now renders HTTP 200 with `Add 1 to 0?`
  in the SSR HTML. Preview mounting then fails while Vite's client dependency
  optimizer runs: a guest Rolldown worker reports `interrupted`, the process
  exits, and the preview times out. Parser calls (60) and shared callable calls
  (271) completed without failures, and shutdown was acknowledged. Evidence:
  `test-results/sdk-site-counter-module-exports`. Hydration, server-function
  clicks and live edits are not yet proven for this candidate. Next, inspect
  the client bundler entry points still executing in guest WASM and extend the
  shared compiler session where appropriate, without bypassing optimization
  or raising limits.
  A second run records the existing interrupt events without enabling extra
  runtime profiling: PID 3 reaches its 30-second session execution deadline,
  not cancellation (`test-results/sdk-site-counter-optimizer-budget`). SSR
  still passes. Vite's actual optimizer calls `BindingBundler.write`, which
  remains in guest WASM. Its plugin callbacks can call the shared resolver,
  so moving bundling requires an asynchronous callback path with explicitly
  scoped nested resolution. A single serialized operation queue would deadlock.
  Preserve synchronous callback contracts and native output wrapper methods;
  do not replace them with Promise-returning stubs. Stop repeating this full
  app run until the bundler transport changes.
  The output transport now passes seven tests, including actual pinned native
  `BindingBundler` output through JSON transport and the unchanged Rolldown
  output wrapper. It preserves chunk metadata, rendered module getters, binary
  assets, error details and released-output behavior. Actual plugin errors are
  encoded before worker messaging so plugin names, hook names and error codes
  survive structured cloning as well as the guest JSON boundary. Evidence:
  `tests/rolldown-binding-output.test.mjs`. Native callback transport and guest
  integration are still in progress; this does not prove optimizer execution.
  The first native backend test now runs bindingified plugin callbacks and
  reconstructs the result through the installed output wrapper. An owner-side
  transport test proves scoped resolver work can run while a build callback
  waits, unrelated parse work remains ordered, and the callback scope expires.
  Evidence: `tests/rolldown-bundler-backend.test.mjs` and
  `tests/rolldown-bundler-owner.test.ts`. The latter uses a simulated worker,
  so browser transport and the real Vite optimizer remain unverified.
  The owner queue also recovers when a nested-resolution callback throws:
  the build rejects, queued parse work still completes, and its scope expires.
  Thirteen owner/parser/workspace tests pass together. The native backend now
  covers `generate`, `scan` and a plugin's nested `this.resolve`; kernel
  integration and production browser-worker transport testing are underway.
  Packaged compiler metadata now lists the experimental bundler operations and
  methods explicitly, retaining the same memory reservation and opt-in policy.
  Nine verifier tests and the real compiler asset-build test pass, including
  provenance hashes for the backend, workspace adapter and output codec.
  The production WASM compiler-worker bundler test now passes in Chromium,
  Firefox and Playwright WebKit: real writes with scoped nested callable
  resolution, JavaScript and source maps matching Node byte-for-byte, parsing
  after bundler close, and acknowledged cleanup. Evidence:
  `test-results/rolldown-shared-native-bundler-fixed`. This uses fixture-owned
  callbacks, not the SDK guest pump or full Vite optimizer. A shared-buffer
  TextDecoder input needed copying to an ordinary buffer for Chromium/Firefox.
  Six kernel-host helper tests pass: output copyback preserves unrelated edits,
  conflicting outputs and quota failures leave all files unchanged, replaced
  symlink paths are reported as conflicts, and callback scopes/routes release
  on close. Two processes reusing the same guest callback ID retain separate
  routes and results (`tests/kernel-bundler-host.test.ts`). The guest adapter, native
  backend, output codec and metadata verifier also pass 24 combined Node tests.
  The kernel factory wiring is not yet ready for a rebuilt full-app run.
  Candidate 8XO5v9 integrates that wiring and builds with a clean typecheck.
  Its full Start run now exits early with unsettled top-level await, before
  server readiness (`test-results/sdk-site-counter-shared-bundler`). The native
  compiler session starts but no parser/callable operations complete, and
  cleanup is acknowledged. Inspect explicit compiler-operation references:
  the kernel's network Promise transport does not itself keep a process alive.
  Do not add a global keepalive or suppress genuine unsettled-await errors.
  Candidate mPI0iz adds references only for queued/running compiler work.
  Helper assertions confirm zero references while idle and after settlement.
  The full app now advances to an explicit config-bundler compatibility error:
  unsupported `sourcemapPathTransform` callback, rather than unsettled await
  (`test-results/sdk-site-counter-bundler-references`). Extend the actual
  output callback contracts and their native parity tests before rerunning.
  The idle-compiler regression passes in Chromium, Firefox and Playwright
  WebKit: a genuinely unresolved top-level await exits with code 13 even with
  the hosted compiler enabled (`test-results/sdk-idle-compiler-references-spawn`).
  The initial test used runModule with session lifetime; corrected it to the
  required spawn API without changing runtime behavior. Output filename/path/
  sourcemap and async banner/footer callback parity now passes against native
  Rolldown, and candidate OUzUJZ includes those contracts.
  OUzUJZ restores server startup and SSR HTTP 200, then times out mounting the
  preview during client optimization. Unlike the earlier run, there is no
  guest interruption or logged compiler error; the server remains active.
  Parser/callable counts are 60/271 with zero failures and no pending callable
  routes. Shutdown is acknowledged. Evidence:
  `test-results/sdk-site-counter-bundler-output-callbacks`. Add bounded bundler
  operation state to identify the outstanding wait before another app run.
  The production guest adapter's nested callback pump also passes inside the
  actual custom QuickJS engine, preserving both request ALS and callback scopes
  10/20/10 (`tests/guest-bundler-quickjs.test.mjs`). No engine change was needed.
  The app harness now records bounded pending/failed browser requests before
  cleanup, including dropped-request counts, for the next diagnostic run.
  Candidate hvPFLY changes the diagnosis: the real app completes config
  generation, dependency scan, optimizer write and all three closes, with
  52 successful callbacks and zero failures or outstanding compiler work.
  The preview document request instead fails `net::ERR_BLOCKED_BY_RESPONSE`.
  Evidence: `test-results/sdk-site-counter-bundler-state`. Investigate the
  service-worker-generated preview response's isolation headers under the
  isolated owner page. Fix the standalone hosting contract, do not disable
  cross-origin isolation to make this test pass. Hydration remains unproven.
  The integrated hvPFLY SDK passes all 24 packaged runtime checks across
  Chromium, Firefox and Playwright WebKit, including live module bindings and
  idle compiler lifetime (`test-results/sdk-fibers-bundler-integrated`). Preview
  hosting is being updated so bootstrap and synthetic workspace responses use
  a consistent `Cross-Origin-Embedder-Policy: require-corp` contract.
- The exact locked portable project renders the counter with HTTP 200 under
  native Node. Both Node and Vite expose `loadServerRoute` as a function. The
  owned control is preserved at `/private/tmp/site-start-counter-native.DGJ17f`.
  A failure-only SDK capture finds no Router modules in Vite's SSR module graph,
  narrowing investigation to external guest module loading. The error cause
  repeats the same Router callsite. Evidence:
  `test-results/sdk-site-counter-module-capture`. Do not change dependencies to
  hide this runtime difference.
  A later import in the failing SDK process exposes `loadServerRoute` as a
  function and `isServer: true` (`test-results/sdk-site-counter-namespace-result`).
  Inspect the initial graph's module identities next; the later namespace does
  not prove which binding Router used. `import.meta.resolve` is also absent,
  but is not established as the cause of the app failure.
  The initial load trace confirms unchanged server-module source and plain,
  matching file URLs, without query variants
  (`test-results/sdk-site-counter-module-identities`). A bounded reproducer in
  `scripts/probe-router-external.mjs --call` now invokes `RouterCore.load()`:
  native Node loads the root route with data `42`, while the same engine and
  guest hooks reproduce the exact `router.js:486:57` failure. Use this smaller
  reproducer for the engine fix before another full-app run.
  `scripts/probe-module-cycle-call.mjs` reduces this to three modules and also
  reproduces it in unmodified upstream QuickJS: a named import re-exported
  through a circular graph leaves a caller bound to a placeholder cell. The
  namespace later shows the function while the caller still fails. Fix export
  resolution to preserve the canonical live binding, with alias, live-update
  and cycle regressions, before rebuilding the app candidate.
- Candidate v9vqeo preserves Error stack traces in console output. The next
  real-app run identifies `HTTPError: not a function` at the loaded Router
  module's `router.js:486:57`, called from `executeRouter`. Investigate the exact
  locked Router 1.171.32 code and any wrapped cause before changing behavior.
  Evidence: `test-results/sdk-site-counter-error-stacks`. Parser/callable counts
  and acknowledged shutdown match gp9pal; SSR remains failing.
- Candidate gp9pal uses bounded iterative JavaScript call frames, with the
  native-entry, reentry, fiber-stack and memory limits unchanged. All 18 packaged
  fiber checks pass (`test-results/sdk-fibers-iterative-profile`). The real Start
  run passes the previous Babel failure, completes 55 parser calls and 244
  callable operations, then returns HTTP 500 with `not a function` in its log.
  The console currently drops Error stacks, so fix that output bug before
  locating the next app failure. Shutdown is acknowledged. Evidence:
  `test-results/sdk-site-counter-iterative-compiler`. No SSR pass yet.
- Candidate 12fFW2 fixes the Vite `load(id, { ssr })` bridge signature. The real
  Start run completes 26 parser calls and 142 callable operations without a
  bridge failure, then SSR returns 500 from a Babel parser stack overflow in
  Start's compiler. Shutdown is acknowledged. Evidence:
  `test-results/sdk-site-counter-shared-load`. Investigate the engine's call
  stack handling next, without increasing limits or bypassing Babel. Hydration,
  server functions and live edits remain unverified on this candidate.
  External packaging, offline install/reinstall, consumer type checks and build
  pass, with 160 payload files and 52,725,418 bytes. Both package builds produce
  tarball SHA-256
  `de671ec62b5e209fa1a32226edf00b11806c0de0e7e890f1fb1f0632c981b1e7`.
  Packaged fiber tests now select engines from the SDK profile mapping, fixing
  skipped initializer profiles. All 18 checks pass in Chromium, Firefox and
  WebKit (`test-results/sdk-fibers-initializer-profile`), covering shared-memory
  budgets, worker parking, memory growth and WASM module transfer. These are
  runtime checks, not a Start app or actual Safari pass.
- Packaged candidate 8y9goo completes 15 shared-session callable operations in
  the real portable Start counter, then returns SSR 500 because the bridge
  rejects Vite's `load` arguments. Shutdown is acknowledged. Evidence:
  `test-results/sdk-site-counter-shared-compiler`. This run reaches a different
  failure than the earlier Tokio worker-capacity error, but does not prove SSR
  or that all worker-capacity problems are resolved. The next fix is to match
  the actual hook call signature, then rerun the same app test.
- The next compiler integration shares one native session between parsing and
  Vite resolution. Focused parser/protocol tests pass, and six guest dispatcher
  tests include a real QuickJS engine retaining separate ALS stores across
  concurrent callbacks. SDK metadata now distinguishes this resolver capability
  from older parse-only artifacts. These source changes are not yet a packaged
  Start app pass. The remaining check is the real app's constructor, resolver,
  file-update and shutdown lifecycle without increasing worker limits.
- Dv4qkO includes the opt-in native Rolldown parser and kernel bridge. Six
  parser cases match Node in Chromium, Firefox and WebKit using the extracted
  runtime (`test-results/rolldown-extracted-parser-*`). The real portable site
  Start fixture reaches SSR, then fails in a later `resolveId` operation because
  the guest Rolldown runtime cannot spawn a Tokio worker thread. Native parser
  state is active with zero pending calls and shutdown is acknowledged.
  Evidence: `test-results/sdk-site-counter-native-parser-coi`. The earlier
  missing-COI test-host failure remains in `sdk-site-counter-native-parser`.
  This does not prove complete SSR or Vite 8 compatibility.
  External packaging, offline reinstall and consumer build pass, with 160 files
  and 52,663,788 bytes. Tarball SHA-256:
  `7af69a8e5b5be281b06d1f2d0ce63dfb33fef95ccace9299e5a6be6a468f3c1b`.
  Parser memory is a separate 1 GiB initial/1280 MiB maximum reservation, not
  included in the guest memory cap. Distribution metadata records missing
  package notice text and unverified embedded Rust dependency coverage.
- The real site `start-counter` fixture preserves the Router example's source
  and manifest. Lockless installation exceeds the 32 MiB metadata limit.
  A generated npm lockfile resolves that install failure without raising limits:
  115 packages install, then Rolldown fails with `Cannot find native binding`.
  Evidence: `test-results/sdk-site-counter`. This is not a Vite 8 app pass.
  A separate portability profile explicitly selects matching Rolldown/WASI
  1.2.9 and LightningCSS WASM. On the threaded rPK7nH artifact it reaches Vite
  readiness, but SSR returns 500 after WASI worker-thread creation fails.
  Exact reservation counts were not captured. Evidence:
  `test-results/sdk-site-counter-portable-threaded`. The next architectural
  investigation is a dedicated compiler backend, not a larger resource limit.
- Rebuilt `sync-o2` engines in VO7GVN fix stale artifacts missing synchronous
  require-ESM support. Twelve native-reference Chromium checks and 127
  profile/verifier checks pass. Verification now rejects missing provenance.
  The full Firefox Start cold/offline-resume workflow passes in
  `test-results/alpha-refreshed-engine-start-firefox`. External pack, offline
  reinstall and consumer build also pass. Tarball SHA-256:
  `b0f790763f27c46fe5d879dacdeb66f8ea38e55b180b4402d08ba541ca50d29c`.
- Schema 3 cache indexing avoids loading archive payloads for metadata and
  eviction. Thirty-one unit checks and fifteen real IndexedDB browser checks
  pass, including migration and data preservation. This fixes unnecessary
  copying, not a proven cause of intermittent installation stalls. SDK peTZyC
  includes this change and the rebuilt sync-o2 engines. Vite and Start each
  pass nine cold/offline-resume runs, three per Chromium, Firefox and WebKit,
  in `test-results/alpha-cache-index-vite-repeated` and
  `test-results/alpha-cache-index-start-repeated`. These are pinned Vite 7
  workflows, not Vite 8 or actual Safari acceptance.
- Actual Safari 26.6.2 UI observations on peTZyC cover two Vite cycles and one
  Start cycle, including edits and reload/resume. Start's counter and server
  function work before and after resume. Only the second Vite cycle blocks
  external connections during resume. Evidence:
  `test-results/alpha-safari-ui/observations.json`. Repeated Safari acceptance
  and byte-exact restore checks remain open.
- The isolated reusable Rolldown session matches Node output before and after
  a file edit in Chromium, Firefox and WebKit. Two native workers are reused
  and closing leaves zero tracked workers. Evidence:
  `test-results/rolldown-native-session-chromium` and
  `test-results/rolldown-native-session-desktops`. This is not yet wired into
  the kernel or real Vite 8 in that probe. Dv4qkO above contains the subsequent
  asynchronous parser integration and its remaining SSR failure.
- `test-results/alpha-packaged-vite-repeated` has six passing Chromium/Firefox
  runs on e2uBeR. Its WebKit results are incomplete: one timeout and two runner
  failures occurred during an accidental pnpm dependency-tree change. The
  npm lockfile was retained and dependencies restored with `npm ci`.
  All Playwright packages again match locked version 1.62.1. The changed tree
  is preserved at `/private/tmp/browser-sandbox-dependency-backup-C0578M`.
  The clean WebKit repeat ended with two passes and one timeout before any
  engine response. This failure remains after dependency repair, so the
  dependency mix-up does not explain it. Desktop repeatability remains open.
- SDK `browser-sandbox-sdk-zYU0xG` packages the opt-in native compiler worker
  with pinned build inputs, provenance and Go notices. External packing,
  offline installation and consumer build pass. Tarball SHA-256:
  `d1c6beed94c6bc618bf3bd04129d60ba9ca642a655121f1ac3a484b7b30b57da`.
- `test-results/alpha-native-compiler-vite-confirmed`: full Vite install,
  edit/test/HMR and offline resume pass in Chromium, Firefox and WebKit on
  zYU0xG. Server-side evidence confirms two native compiler worker requests per
  engine, one for each cold/resumed runtime. Existing app limits are unchanged.
- `test-results/alpha-native-compiler-start-firefox`: Firefox passes the full
  Start cold/offline-resume workflow on zYU0xG, including SSR, hydration,
  server-function POST, navigation and document-preserving HMR. Both rounds
  restore/retain 6,158 files and finish with zero processes, network handles
  and file sessions. No browser diagnostics were reported. This is one pass,
  not yet repeated desktop coverage or actual Safari evidence.
- `test-results/alpha-native-compiler-start-repeated`: terminal result is nine
  passes in 6.4 minutes on zYU0xG, three per Chromium, Firefox and WebKit.
  All nine result files confirm two compiler workers, two 6,158-file rounds,
  and zero remaining process, network, datagram and file-session resources.
  Chromium records blocked blob-worker diagnostics; WebKit records blocked
  stylesheet diagnostics. These did not fail the app assertions and remain
  visible limitations to investigate, not evidence of a clean console.
- SDK `browser-sandbox-sdk-e2uBeR` packages runnable Vite and Start examples.
  External consumer verification passed. Its 74 runtime/index files match
  zYU0xG byte-for-byte, but earlier app results remain attributed to zYU0xG.
  Tarball SHA-256:
  `5b2f08a167b39ea41fe385489dc63fe00ca55d0f6947ba1a39324c5bc2301189`.
  `test-results/alpha-framework-example-packaged` contains two Chromium passes
  for the packaged examples, including editing and offline resume. This does
  not yet establish repeated cross-browser example coverage.

- `test-results/alpha-start-vite7-baseline`: both Chromium and Firefox fail
  Start SSR with a Babel parser stack overflow on the default synchronous
  engine in SDK `browser-sandbox-sdk-YCHhXo`.
- `test-results/alpha-start-vite7-sync-o2`: SDK `browser-sandbox-sdk-xReKVB`
  passes the full cold Start workflow in Chromium. Firefox returns SSR 200 but
  does not hydrate within 60 seconds. Limits and app assertions are unchanged.
  This profile includes managed interpreter frames, not just an O2 flag.
- SDK `browser-sandbox-sdk-RsR1NM` adds the packaged quickstart. Its manifest
  verifier and external package consumer acceptance pass, including identical
  tarballs from two pack operations, offline installation and consumer build.
  The tarball SHA-256 is
  `7549bf0f4b62fcc0fdfd571294b61e9842a56685b2338a096d11294a061ca904`.
  This proves packaging, not complete app compatibility or release readiness.
- `test-results/alpha-start-resume-sync-o2`: one Chromium full Start
  install/edit/save/offline-resume workflow passes in 51.3 seconds on RsR1NM.
  The test verifies every restored file byte and workspace metadata before
  restarting, then repeats SSR, hydration, POST, navigation and live edits.
- `test-results/alpha-start-resume-repeated`: six passes, three Chromium
  and three Playwright WebKit runs, on RsR1NM. Each restores 6,158 files and
  finishes with zero retained processes and network handles. Manifest SHA-256:
  `c648a8e393df5c49a8f1b47459682897324dd1f59cdc90268648c6cbc9fee5bb`.
- `test-results/alpha-vite7-resume`: the initial 256 MiB-per-process setup
  exhausted the 512 MiB total reservation before a concurrent test could run.
  `test-results/alpha-vite7-budgeted-resume` passes all three browser engines
  at 128 MiB per process. No global limit, test assertion or deadline changed.
- `test-results/alpha-vite7-resume-complete`: nine passes, three cold/offline
  resume cycles per browser engine on RsR1NM. The earlier
  `alpha-vite7-resume-repeated` run lost its process handle after five saved
  results and has no terminal result; it is not counted as a complete run.
- Actual Safari 26.6.2 is installed. Its driver rejects session creation
  because Allow remote automation is disabled. The user has been asked to
  enable it; no Safari settings were changed automatically. Once enabled,
  `SDK_OUTPUT=... SDK_TARBALL=... SDK_MANIFEST_SHA256=... SDK_BUILD_PROFILE=...
  SDK_TARBALL_SHA256=... npm run test:safari-frameworks` runs three independent
  Vite and Start cold/save/offline-resume rounds and records the exact artifact
  identity. The harness cannot report a pass from Playwright WebKit or from a
  partial Safari run.
- `examples/sdk-basic` is a runnable public-SDK consumer with two local origins,
  edit/run/output, virtual HTTP preview and file save/resume. Its external
  tarball-install acceptance passes in Chromium, Firefox and WebKit in
  `test-results/alpha-sdk-basic-example`. The rendered UI was inspected.
  It is not a replacement for the full Vite and Start examples.
- SDK `browser-sandbox-sdk-KB0Wo1` packages that example as `examples/basic/`.
  External packing/install/build verification and all three browser consumers
  pass in `test-results/alpha-packaged-basic-example`. Tarball SHA-256:
  `b7ba8044b63f467c0f61f69c1d3bb9f19380207fbec6145dc158e76828ccaad7`.
  Full workflow results above remain attributed to RsR1NM, not this new archive.
- SDK `browser-sandbox-sdk-7oZ16R` fixes positional reads and writes through
  workspace file leases. The prior archive fails the new regression test in
  `test-results/alpha-positioned-files-before`; the new archive passes all six
  example/file-position checks in `alpha-positioned-files-fixed` and all three
  full Vite workflows in `alpha-workspace-fix-vite`. Earlier repeatability
  evidence is not relabeled as testing this archive.
- TanStack.com has an adapter seam in `ExampleWorkbench.client.tsx` and
  `example-webcontainer.client.ts`. Integration needs explicit SDK preview
  ownership and installer contracts, not a claim of pnpm or jsh compatibility.
  No site files have been changed or deployed.
- `test-results/browser-compiler`: nine passing tests across Chromium, Firefox
  and Playwright WebKit. The browser-native compiler reads live workspace files,
  creates its output directory and writes executable output. One service worker
  accepts two build packets around a file edit; the output changes from 42 to 43.
  Owner leases and descriptors return to zero. This uses a test-only protocol
  caller, not the installed Node wrapper, Vite, incremental contexts or Safari.
  The reusable runner also passes two builds and normal stdin-EOF shutdown in
  each engine. It uses acknowledged output and pull-based stdin. Four focused
  tests cover backpressure, abort cleanup, capped artifacts and workflow deadlines.
  Exact esbuild artifact preparation passes three tests without rewriting
  installed files. The combined compiler/filesystem suite passes 33 tests and
  TypeScript checking passes. The runner is not enabled in the SDK.
- `test-results/kernel-compiler`: the unchanged esbuild Node wrapper passes
  builds, guest plugin callbacks, live file edits and TypeScript transformation
  in Chromium, Firefox and Playwright WebKit with guest WASM disabled. Direct
  CLI version output is captured too. The opt-in lab backend retains ordinary
  process reservations and file authority. Policy/process/artifact checks pass
  34 tests and TypeScript checking passes. SDK use explicitly throws unsupported.
  The initial bounded backend has now gained explicit owner-opted session
  accounting. All nine kernel/compiler checks pass across the three engines:
  ordinary builds, idle context rebuilds and slow-plugin deadline cleanup.
  Session requests keep deadlines through plugin callbacks; idle time is allowed.
  Esbuild watch/serve remain unsupported. The 49 policy/process/runner/artifact
  checks pass. Full Vite/Start integration with this backend is still unproven.

## Execution decisions

- SDK `browser-sandbox-sdk-QA3oVl` is the first package whose public framework
  example selects the complete supported Start profile from its own manifest:
  the fiber QuickJS engine, opt-in native Rolldown parser, browser compiler and
  cross-origin-isolated owner. Missing parser metadata now fails before startup
  instead of falling back to the QuickJS parser, which deterministically
  overflowed on the supported Start fixture. Manifest SHA256:
  `97e09d7479d7736712fe583a38148af7b536e054ed390973cab5234b2bd6417a`.
  Package acceptance passes with 175 files and 52,976,579 manifest bytes; the
  finalized attested tarball SHA256 is
  `8fbff813e04949fe05c591e0aefccea3ecd1cf6931315aed4bf074a820fa343f`.
  Three complete registry-install, SSR, hydration, POST server function,
  navigation, live-edit, save, owner-reload and byte-exact offline-resume
  cycles pass sequentially on the exact artifact in each of Chromium, Firefox
  and Playwright WebKit. The original cycle timings were 27.7 seconds, 1.6
  minutes and 34.8 seconds respectively. Evidence:
  `test-results/sdk-start-QA3oVl-chromium`,
  `test-results/sdk-start-QA3oVl-firefox` and
  `test-results/sdk-start-QA3oVl-webkit`, plus the matching `-repeat`
  directories. The exact package also passes three Vite 7 registry-install,
  test, live-edit, HMR, save and offline-resume cycles in each engine under
  `test-results/sdk-vite7-QA3oVl-*-repeat`. The candidate evidence record binds
  and content-audits 37 result files, including the real TanStack.com
  integration and a minimum of three independent cycles per engine for both
  packaged apps. WebKit exposed an SDK-owned bridge CSP
  diagnostic. The bridge now explicitly permits inline presentation styles
  while retaining `default-src 'none'`, self-only scripts and workers, bounded
  same-origin connections, and disabled base and form targets. Guest preview
  policy remains separate and unchanged. Actual Safari remains unverified:
  the artifact-bound harness exits with
  `ERR_SAFARI_REMOTE_AUTOMATION_DISABLED` until Safari's user-controlled
  Develop > Allow Remote Automation setting is enabled. Playwright WebKit is
  not Safari evidence.

- SDK `browser-sandbox-sdk-wutr8Q` is the current Vite 8 experimental
  candidate. Its manifest SHA256 is
  `155ef06761b32a3a2223d42f1e0ba4b50e982eed38140d55510d8871c48a0066`;
  verification covers 174 files and 52,974,713 bytes. The package tarball
  SHA256 is
  `42f2da9ae343ef8e647a362e211d45ef8bb7752fb0a4ae39e05cf5b51a5f342b`.
  External install, offline reinstall, public types and consumer build pass.
  Its candidate compatibility record binds claims to the exact manifest and
  build profile. Chromium and Playwright WebKit each pass one complete Start
  cold/edit/save/host-reload/offline-resume workflow in 43.9 and 54.4 seconds,
  with retained evidence in `test-results/sdk-site-counter-wutr8Q-chromium`
  and `test-results/sdk-site-counter-wutr8Q-webkit`. Two catch-all Playwright
  route interceptors had caused earlier post-save stalls. Replacing them with
  passive request observation retains the zero-external-request assertion and
  removes Playwright from the request path. The exact candidate also passes the
  real TanStack.com integration after being installed from its tarball. This
  proves working Start executions, not repeated Start reliability. The exact
  candidate also passes three complete Vite 7 cold/edit/test/HMR/save/reload/
  byte-exact-offline-resume cycles in each of Chromium, Firefox and Playwright
  WebKit. The candidate record binds all six Vite cold/resume cells to those
  retained artifacts. A separate evidence audit verifies 22 referenced JSON
  files against the manifest, engine hashes, workflow results, resource cleanup
  and zero external resume requests. Firefox Start and actual Safari remain
  unverified in this candidate record. Playwright WebKit is not Safari evidence.

- wutr8Q adds an artifact-specific Rolldown parser notice inventory. It binds
  seven installed packages to exact input, lock, package metadata and notice
  hashes. The Rolldown binding and NAPI WASM runtime still contain no package
  notice text, and embedded Rust dependency coverage is still unverified.
  `distributionReview.complete` therefore remains false. This is provenance
  evidence, not legal clearance or a completed distribution review.

- The Vite 8 Start Firefox hydration investigation is closed for the current
  release candidate. A generation-safe preview WebSocket handoff now retains
  the leaving document's server socket during replacement, drains it, and
  replays only bounded `full-reload` frames. This fixes the previously lost
  second optimizer reload, and focused lifecycle tests cover a `pagehide`
  before the replacement document announces itself. Firefox now performs the
  initial navigation and both optimizer reloads, loads the final 111-resource
  client graph, and reports no native parser or callable failures. It still
  does not hydrate, with two aborted dynamic-entry imports retained from the
  replaced documents. A separate attempt to warm the virtual client entry
  through Vite's environment API failed before transformation and did not
  change the app result, so that test-only change was removed. Do not add
  another timeout or another reload timing patch. Keep Vite 8 on Chromium and
  WebKit as experimental, and use the repeatedly verified Vite 7 Start path as
  the alpha compatibility boundary until the client bootstrap architecture is
  changed.

- Current work is functional compatibility and reliability for projects we own
  or have permission to test. Use local fixtures and ordinary development
  workflows. Defer exploit development, sandbox-escape attempts, credential
  access probes and testing against third-party systems. Do not weaken existing
  protections or disguise a blocked experiment to continue it. Record the
  limitation and move to an independent functional requirement instead.
- This scope change does not establish security readiness. Keep that review
  separate, and do not describe the alpha as safe for arbitrary hostile code.
- Pause isolated API expansion, including transitive SQLite initialization,
  unless a representative app requires it. Preserve its work and failing tests.
- Limit an investigation to two experiments without a changed implementation
  decision. Then choose a different approach and record the limitation.
- Evaluate an explicitly supported Vite 7/Rollup/esbuild compiler path alongside
  fixing Vite 8/Rolldown worker allocation. Both must meet the same complete app
  gates. A documented version support boundary is allowed; hidden substitution
  or replacing Start with a simpler app is not.
- The managed-frame sync engine removes the observed Start SSR blocker, but
  does not resolve Firefox hydration. Do not repeat the same profile comparison.
  Next runtime investigation: an explicit, matching-version esbuild service
  backend in a browser worker. Keep esbuild's guest wrapper, plugin callbacks
  and filesystem behavior; do not route Vite through the SDK's opinionated
  project compiler. Establish bounded worker memory and lifecycle ownership
  before integrating it. This is a candidate architecture, not implemented
  support or a proven Firefox fix.
- The capped compiler prototype passes one version-matched TypeScript
  transform and five memory-policy tests. It explicitly changes the declared
  WASM memory maximum and records that distinction. It is not wired into the
  SDK; browser queue accounting, workspace filesystem and guest plugin callback
  support remain unproven. See `reports/capped-esbuild-service-prototype.md`.
- A separate Node-hosted prototype now preserves the stock esbuild Node wrapper
  and its `hasFS:true` protocol through a staged launcher. A filesystem-backed
  TypeScript build with `write:true` and caller-side plugin callbacks pass.
  Its live workspace lease closes on shutdown with zero descriptors or sessions.
  Node worker heap limits are not browser heap guarantees. Guest-process
  integration and active-build cancellation remain unverified. The combined service,
  memory-policy and filesystem suite passes 26 tests; no SDK backend changed.
- The live compiler filesystem adapter now uses owned workspace leases with
  positional I/O, directory creation and bounded short reads/writes for large buffers. Nineteen
  adapter, lease and descriptor tests pass. This adapter is not yet a selected
  compiler backend, and its callback tests do not prove browser transport.
- Parallel work: runtime architecture, public SDK/release readiness, and the
  TanStack.com adapter. Only integrate after the standalone workflow is proven.

