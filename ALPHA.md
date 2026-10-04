# Browser sandbox alpha launch checklist

This is the only active launch checklist. The alpha is not ready to release.
Earlier status claims and commands are preserved in
[the historical log](reports/alpha-history-2026-09-23.md), not a second release gate.

## Current browser-native release path

Current Linux follow-up, October 4: fresh runtime and private package builds,
consumer adoption and all 212 release checks pass. Chromium and Firefox pass
all five examples, but WebKit fails Router SSR's original 30-second HTTP
readiness deadline after three examples. A separate same-pair traced diagnostic
passes all five with no memory-limit or OOM events, it does not repair or replace
the failed full gate. A reviewed checkpoint branch is approved for Linux x64 CI,
not publication or a change to main. See
[Linux build and checkpoint evidence](reports/native-current-linux-ci-checkpoint-2026-10-04.md).

Current-pair site and terminal checks, October 4: the latest compiler-startup
metadata pair passes two complete strict four-example workflows per desktop
engine, six of six, plus all twelve original terminal/production-build cells.
Full site TypeScript, five header checks and 17 harness checks pass. Independent
verification binds the installed pair, unchanged project/integration inputs and
actual browser lock, all 42 milestones, twelve navigation identities and 120
progressive updates. Private hosts are stopped, user 4198 untouched. This closes
this pair's planned Mac site repeat and single terminal matrix, not final alpha
acceptance, Linux/x64, repeated terminal reliability or production dogfooding.
Earlier intermittent failures remain failed and unexplained. See
[current-pair site and terminal evidence](reports/native-current-pair-site-terminal-2026-10-04.md).

Compiler startup follow-up, October 4: the native runtime now reports download,
WASM byte reading, WASI initialization and compiler-worker readiness through
existing progress events. Six checks prove the pinned loaders' original code
is unchanged apart from metadata and that reporting does not replace errors.
A fresh locked Mac build passes all 212 release, 60 installer, 11 harness and
four input checks. The complete expanded SDK driver passes all five examples
in every desktop engine, both toolchains' directory/context checks and all
48 command lifecycle runs. Independent verification confirms the observed
startup stages, exact source/package identities and unchanged WASM bytes.
This is one full run per engine, not a fix for the preceding intermittent
WebKit timeout. The new pair still needs Linux/x64, repeated site/terminal
checks and final publication review. See
[compiler startup evidence](reports/native-compiler-bootstrap-2026-10-04.md).

Command lifecycle follow-up, October 4: the unchanged Mac SDK pair passes
48 ordinary Node command runs across both compiler versions in Chromium,
Firefox and WebKit. Natural completion, ready-confirmed cancellation and
replacement commands leave no active commands or browser errors. This small
control does not reproduce or waive the previous full WebKit startup failure.
The private build driver now requires these six pairs too. A fresh locked
source copy passes all 206 release and 24 worker-cleanup checks. The local
checkout has mismatched filesystem dependencies, its failure is retained and
the existing install is left alone. No runtime repair or new full-build
acceptance is claimed. Next split compiler bootstrap observations into
download, WASM initialization and worker-pool readiness, rather than rerun
the same broad gate. See
[command lifecycle evidence](reports/native-command-lifecycle-2026-10-04.md).

Mac and real-site checked writes, October 4: a declared-operation check fixes
generic proxy compatibility, all 60 installer tests pass. Fresh locked Mac
builds and consumer checks pass. Chromium and Firefox pass all five SDK examples,
WebKit times out loading Rolldown in an owner control before any examples.
A separate same-pair phase-logged WebKit run passes that control and all five,
the failure is retained and unexplained. All six directory/context pairs pass.
The new pair passes all four real-site examples in every engine with the
existing official 1.63.0 site runner, all 60 progressive updates and full site
TypeScript checks pass. This is one workflow per engine, not repeated acceptance.
No runner upgrade or full SDK gate is approved. See
[Mac and site evidence](reports/native-checked-write-mac-site-2026-10-04.md).

Checked writes, October 4: the full Linux ARM64 SDK driver now passes all five
pinned examples in Chromium, Firefox and WebKit, plus all six installed
directory/context pairs. The shared filesystem performs each checked write in
one owner call, preserving current path checks, modes, errors and change tracking.
All 205 release, 59 installer, 11 harness and four input tests pass. Fresh runtime
and private package builds and consumer adoption pass with original deadlines
and limits. The older codec fixture's CI setup and peer lock are repaired,
earlier failures retained. The exact new pair still needs Mac/full-site checks,
x64 CI and final publication review. Nothing published. See
[checked-write evidence](reports/native-checked-write-2026-10-04.md).

Install profiling, October 4: the same installed Linux pair passes Solid alone,
but the complete WebKit batch still reaches its original 180-second deadline
after the first four examples. No OOM event. Solid's 20.7-second install makes
63,716 synchronous filesystem calls taking 16.4 seconds. Next reduce worker
round trips by moving each checked write into one owner operation, preserving
the current checks and behavior. All 181 local release checks pass. No runtime
repair or acceptance waiver is claimed. See
[installation evidence](reports/native-install-phases-2026-10-04.md).

Compiler-memory candidate, October 4: browser bindings start at the module's
actual minimum, about 63 MiB for Rolldown and 61 MiB for Oxide, with original
shared memory, growth, 4 GiB maximum and unchanged WASM bytes. All 170 source
checks, fresh Linux builds and consumer adoption pass. The full Linux driver
still fails, Firefox times out after four examples. Separate WebKit also times
out after four, without an OOM event, and all six directory/context pairs pass.
No full acceptance gate closes. Next profile installation, about 81 percent
of the four completed WebKit startups. The earlier memory failure remains
unexplained. This new runtime pair still needs Mac/full-site acceptance. See
[candidate evidence](reports/native-compiler-memory-2026-10-04.md).

Linux ARM64 check, October 4: fresh Go/Rust runtime and private SDK builds,
consumer installation and reinstallation pass after correcting the named WASM
interface check and adding official ARM64 toolchain selection. Chromium and
Firefox pass all five examples, WebKit hits the unchanged full-workflow deadline.
A separate trace run passes Streaming, then the kernel kills WebKit's web
process at the same 6 GiB limit while Router installs. All six installed
directory/context pairs pass separately. Neither failure is waived, full Linux
acceptance and x64 CI remain open. Memory across project startup and disposal
needs investigation before a fresh full check. Nothing published. See
[Linux evidence](reports/native-linux-build-2026-10-04.md).

Repeated real-site check, October 4: the unchanged strict four-example driver
passes three complete workflows per desktop engine, nine of nine. Independent
verification checks every milestone, navigation identity and all 180 progressive
stream updates against stable current inputs. Earlier failed receipts remain
unchanged, no runtime fix is claimed. This closes the current private pair's
planned repeat check, not the final alpha, expanded terminal reliability or
production dogfooding. See
[repeat evidence](reports/native-four-site-reliability-2026-10-04.md).

Four-example real-site check, October 4: the strict full-site driver now covers
Counter, Basic, Streaming and Router in every desktop engine. One complete
batch passes all three workflows, including raw SSR, binary assets, deferred
server functions, navigation, live edits and both progressive streams. Project
payloads and the actual runner lock/catalog are verified. Two earlier failed
attempts remain failed, the new transition now waits for client readiness and
navigation checks document identity rather than exact clock equality. No SDK
fix, repeated reliability or release approval is claimed. See
[four-example evidence](reports/native-four-site-acceptance-2026-10-04.md).

Launch fixture update, October 4: the five official examples now use revision
`b839f47027956f71ed2db51f436701801addb1d6`. A fresh capture verifies their bytes
against upstream Git, and the old suite remains replayable under
`reports/inputs/native-examples-6f882b7`. The normal unchanged release batch
passes all fifteen development example/browser cells with CI's locked browser
versions and the existing installed pair. The real-Node Streaming control now
uses the same pinned source, manifest and lock, its declared build passes with
native TypeScript 7. Browser type checking still uses the JavaScript checker.
No source-bound alpha is approved and nothing is published. See
[launch fixture evidence](reports/native-launch-fixtures-2026-10-04.md).

The dated checks below retain earlier failures and their artifact identities.
They do not override the current launch gates at the end of this section.

Terminal reset investigation, October 4: the failure collector now preserves
the initial timeout even when the terminal disappears. All 25 focused harness
checks pass. Three targeted WebKit Basic runs pass, then a fresh site's full
twelve-cell terminal sequence passes in every engine with the unchanged SDK,
renderer, examples and behavioral gates. The earlier 11/12 failure is retained
and its reset remains unexplained, this is new passing evidence, not a runtime
fix or release approval. See
[reset investigation](reports/native-terminal-reset-diagnostics-2026-10-04.md).

Current-source real-site check, October 4: the approved renderer and unchanged
installed Container pair pass the strict Counter/edit/restart/reload and both
progressive streams in all three desktop engines. Frozen site install, full
typecheck and route header checks pass. The original terminal matrix completes
11/12 cells, WebKit Basic loses the terminal and returns to the original files
during its build check. That gate stays failed, no retry or deadline change.
The newer snapshots are not promoted over the old launch suite. See
[current-source site evidence](reports/native-current-upstream-site-2026-10-04.md).

Current official example check, October 4: all five examples at upstream
revision b839f47 pass development and production API checks in every desktop
engine, 15/15. The installed Container pair and original root fixtures stay
unchanged. The old Streaming source error is already fixed upstream; the newer
source also builds in real Node. This uses the existing JavaScript TypeScript
checker, not the native TypeScript 7 executable. A timed-out combined workflow
stays failed, current-source full-site/terminal and other launch gates remain
open. See [current-source evidence](reports/native-current-upstream-production-2026-10-04.md).

Owning renderer release review, October 4: the cleaned-up Redact recovery passes
all 36 isolated context cases, its unit suite and type/build checks. The unchanged
strict site driver passes Counter/edit/restart/reload and both progressive
streams in all three engines with the rebuilt renderer and unchanged Container
pair. No host error is waived. After measuring the pristine baseline, the DOM
budget explicitly accepts a 41-byte gzip correctness cost and keeps the documented
25-byte margin. The combined client is 61 bytes smaller, all 38 reviewed size
rows pass. The missing upstream notice and other alpha gates remain open.
Nothing published. See
[release review evidence](reports/redact-recovery-release-review-2026-10-04.md).

Terminal settlement check, October 4: the current installed pair passes 180
marker-verified stress commands on the real Streaming workbench across all
three engines, including sixty missing-command failures and recovery. The
earlier timeout's cause remains unproved. The unchanged strict driver completes
all five functional milestones in Chromium, including both progressive streams,
then fails on the host hydration error and stops. No error is waived and no
runtime workaround is added. See
[terminal and strict-site evidence](reports/native-terminal-settlement-2026-10-04.md).

Host hydration check, October 4: a standalone browser reproduction now isolates
provider loss without the container, router or site. React passes all eighteen
cases, Redact loses the provider above the document shell in the mismatch case
on all three engines. The diagnostic stays failed, no container workaround was
added. The owning renderer needs the fix before strict full-site acceptance.
See [isolated hydration evidence](reports/host-hydration-context-2026-10-04.md).

Full local source check, October 4: the unchanged `check-native-sdk.mjs`
command completes from a fresh locked checkout on this Mac, with fresh Go
shell and Rust scanner builds. Both runtime variants and the private SDK pair
build, install and pass all fifteen development example cells and six installed
directory/runtime/browser pairs. Their tarballs match the previous verified
build. All 23 focused source, 164 release and 11 site-harness checks pass.
This closes the local fresh-build gate, not Linux GitHub CI, full-site or
production acceptance. Missing upstream notice, distribution review, exact
SolidJS launch coverage and publication remain open. Nothing published.
See [full source check evidence](reports/native-full-source-check-2026-10-04.md).

Cross-folder build check, October 4: compiler inputs now use a verified,
content-addressed directory inside the checkout. Both runtime variants, both
private SDK builds, split package files and npm tarballs match exactly across
two fresh locked checkouts. The compiler keeps its normal browser mappings and
resolution, no generated-output rewrite is used. This is same-host reproduction
with verified Rust/Go artifacts reused, not cross-platform toolchain acceptance.
The new installed pair passes all fifteen development example cells and six
directory/runtime/browser pairs. All 23 focused source and 164 release checks
pass. One upstream notice, full-site and production failures, exact SolidJS
coverage, full fresh-build CI and publication remain open. Nothing published.
See [cross-folder build evidence](reports/native-compiler-reproducibility-2026-10-04.md).

Rust notice check, October 4: five missing crate notices now bind to their
verified archives and exact upstream revisions. A fresh scanner compile
produces the same WASM with unchanged compiler and compiled-package identities.
Both runtimes and the private SDK pair are rebuilt. Packing, clean consumer
adoption, offline reinstall, all fifteen development example cells and all six
installed directory/runtime/browser pairs pass with CI's desktop runner.
Eighteen focused source checks and all 164 release checks pass. One npm notice,
`napi-wasm@1.1.3`, remains missing, distribution review is not complete. A byte
comparison also finds checkout and extraction paths in compiler JavaScript,
so cross-directory runtime reproducibility remains unproven. Full-site,
production and the complete fresh-build CI gates remain open. Nothing published.
See [notice and packaging evidence](reports/native-rust-notices-and-packaging-2026-10-04.md).

Older-browser cleanup check, October 4: CI's WebKit 26.5 exposes handle methods
being created before disposal symbols exist. The native compatibility layer now
installs missing symbols before those classes. A fresh installed pair passes
the original five development examples in both older and newer desktop runners,
30/30, plus all twelve directory/runtime/browser pairs. The fresh site check on
the previous pair completes functional milestones but fails host page errors,
and its production matrix has nine passes and three original Streaming build
failures. These are retained failures, not alpha acceptance. The new pair still
needs full-site and production retesting, the complete fresh-build CI driver is
not verified. All 64 focused filesystem checks, 30 related Vitest checks and 164
release source checks pass. Nothing is published.
See [site and cleanup evidence](reports/native-site-and-disposal-symbols-2026-10-04.md).

Directory package check, October 4: both runtime variants now include owner-held
Node directory handles. The fresh private SDK pair passes all five development
examples in all three desktop engines, 15/15. The installed sandbox Node command
also passes all 26 directory checks, named exports and browser-native callback
context in both variants and every engine. Native SDK CI now requires that
installed control alongside the example batch, six accounting tests and all
164 release source checks pass. The full extended CI driver and GitHub run are
not yet verified. Full-site and production acceptance, exact SolidJS coverage,
distribution review and publication remain open.
See [packaged directory evidence](reports/native-directory-packaged-2026-10-04.md).

Compiler filesystem check, October 3: source now pins memfs 4.70.0, the first
tested upstream release that opens `/` correctly. Workspace mounts preserve
the root inode instead of resetting the namespace. Rolldown now selects the
worker's shared filesystem. Live stats and directory entries use the backend's
own classes. Seventy-eight focused source checks, fifteen WASI/transport
controls and all 163 release checks pass. A clean installed package matches
Node on all 18 direct resolver calls in every desktop engine. Its full workflow
then fails Basic client loading. A bounded native Oxide control completes for
one file but stalls for 32. The Oxide sharing experiment is removed, its
existing scanner path remains unchanged. The narrower clean-installed package
passes all five development examples in each desktop engine, 15/15, including
both progressive streams and the owner/terminal/agent checks. Native Oxide
filesystem scanning remains an open gap, these passes use its existing adapter.
The site, production, full SolidJS and release gates remain open. No site change
is claimed.
See [shared filesystem evidence](reports/native-shared-compiler-filesystem-2026-10-03.md).

Latest real-site check, October 3: the transport-corrected ordinary package is
now in a fresh fixture of the current TanStack.com checkout. Its frozen install,
full typecheck and four-native/one-lightweight route header checks pass.
Chromium completes Counter edit/restart/reload and both progressive streams,
but the full workflow stays failed on a parent-site Redact error. A separate
lightweight Store control reproduces the same `_notFound` exception without
booting a native container. Expanded Firefox still fails normal preview-frame
reads after reload while the independent inspection channel sees Counter 41.
No error, assertion or deadline is waived. The harness now supports a verified
external browser runner and preserves messages when browser error stacks are
empty. Sixteen focused checks and all 163 release source checks pass.
See [current-site adoption evidence](reports/native-site-transport-adoption-2026-10-03.md).
No main-site edit, dependency change or publication occurs. Resolve the parent
site/renderer exception in its owning project and retain the separate Firefox
gate, neither the partial site result nor earlier SDK passes make alpha ready.

Latest check, October 3: browser-only listener registration capture is now
available alongside click delivery. A callback-wrapping experiment is removed
after WebKit exposes changed native error reporting, registration-only controls
pass in all three engines. Three complete fresh observed Firefox workflows
pass, then the unobserved desktop batch passes all five examples in each engine,
15/15, including both progressive streams and the owner/terminal/agent controls.
Package and compiler bytes are unchanged from the transport-corrected pair.
No failing click is captured and no runtime fix is claimed. The earlier
no-request Streaming failure remains unexplained. Six observer source checks,
ten related observer/capture checks and all 163 release source checks pass.
See [registration and repeat evidence](reports/native-click-registration-2026-10-03.md).

Transport check, October 3: the owned chunked filesystem transport fixes the
known reply-size and terminal-settlement defects in both pinned Rolldown and
Oxide paths, without increasing the shared lane or replaying operations.
Both upstream codec versions pass real-worker controls in Chromium, Firefox
and WebKit, including large replies/errors and worker cleanup. The final
clean-installed pair passes all five development examples in each engine,
15/15, with observers off, both progressive streams and the terminal/agent
controls. All 163 release source checks and 17 focused source checks pass.
Details and bound receipts:
[filesystem transport evidence](reports/native-wasi-fs-transport-2026-10-03.md).
The precise earlier failing filesystem method was never captured. The distinct
no-request Streaming failure remains unexplained, these passes do not establish
a common root cause. The older Oxide codec's binary format is unchanged.
The actual rebuilt inventory still reports a missing napi-wasm notice and
incomplete distribution review. Full-site Firefox, full SolidJS and declared
production acceptance remain separate gates. Nothing is published.

The first milestone is an alpha that can reliably power TanStack.com examples.
Then continue closing general WebContainer compatibility gaps. Simple inline
examples keep their lightweight runtime. The first npm publish belongs to the
maintainer, nothing here authorizes publishing or a production deployment.

The latest package work is the API 8 native-only pair described below. Its
installed consumer `8in22f` additionally passes three consecutive complete
five-example Firefox development and owner/terminal/agent workflows, with both
streams delivering early DOM updates. A passive diagnostic observer leaves
sources and deadlines unchanged. The earlier intermittent streaming failure
is not explained, and these SDK checks do not close the full-site Firefox gate.
See [repeated streaming evidence](reports/native-owner-stream-repeats-2026-10-03.md).
The release unit suite now passes all 163 tests. The private native CI driver
also passes a clean local source build, consumer adoption and the five-example
desktop SDK batch. Its new read-only workflow retains result metadata only,
and has not run on GitHub. See [private native CI evidence](reports/native-private-ci-2026-10-03.md).
A fresh isolated site fixture
`1wTw9Y` uses this API 8 pair on ports 4297/4298/4299, its locked dependency
install and full site typecheck pass. Counter edit/restart/reload and progressive
streaming pass in all three desktop engines. Chromium also passes Counter,
Basic and Router terminal/edit/build/restart workflows. Expanded terminal
checks pass once in Chromium and WebKit, but Firefox fails its first Counter
reload, the separate inspection channel and screenshot show a complete page
while normal automation frame reads time out. That result stays failed.
See [latest local site evidence](reports/native-site-api8-adoption-2026-10-03.md).

An earlier Firefox SDK diagnostic fails Counter client-module loading.
Owner and Worker traces narrow the stall to outstanding HTTP reads while the
Worker remains responsive, without proving its cause. The observer control
passes in all three desktop engines, that is not application acceptance.
See [Worker I/O evidence](reports/native-worker-io-2026-10-03.md).
New guest-source and installed-owner HTTP pressure controls pass in all three
engines, including cancellation with an occupied capacity pool, large bodies
and cleanup. They narrow the investigation but do not clear the real-example
Firefox failure. See [HTTP pressure evidence](reports/native-http-pressure-2026-10-03.md).

The retained port 4198 site still uses private candidate `gad8Op`, split as `9hKbz3` and
installed in consumer `ldqHOV`. Both pinned runtimes include the file/port reply predicate
fix. Package checks, real worker predicate checks and installed owner terminal/
HTTP checks pass in the three desktop engines. The l06ZLg site fixture passed
18 repeated Counter/Basic/Router workflows and full three-engine Counter and
progressive-stream acceptance. Expanded terminal checks then exposed panel
visibility, word deletion and interrupted typeahead gaps. Those integration
fixes were tested in fixture GpXfmJ, whose full acceptance remained open.
A pinned Node/Vite control then proved unrelated/data file writes should not
force preview reloads. That extra workbench reload is removed. Clean fixture
yQtTBc passed hydrated source edits, word deletion and interrupted typeahead in
all three engines, but the combined Firefox run still hid its next prompt.
Transport and buffer traces prove the command finished and the prompt was
written offscreen. The retained clean fixture is `5KNQNx`, without diagnostic
terminal instrumentation. Its content-box fit layout passes the combined
Chromium checks and gets past Firefox's missing prompt. Firefox then failed
once at preview reload and passed the same expanded workflow on a repeat.
That intermittent failure remains open. Earlier integration passes do not
accept this changed template, full repeat and streaming checks are still due.
The startup click diagnostic also proved network idle could precede React
hydration. The Counter test now waits for its existing client-mounted UI before
making a single mutation, without SDK framework hooks or rewritten examples.
The fresh clean-template Counter and streaming workflow passes in all three
engines, session 93324, including edit, Run restart, fresh page reload and both
progressive streams. Session 3059 then passed all 18 repeated Counter, Basic
and Router terminal/edit/build/restart workflows, twice per app and engine.
Expanded session 11139 passes in all three engines, including scrollback,
resize, completion, paste, editing, interruption, panel toggles and editor
sync. The earlier intermittent Firefox preview reload failure did not recur,
but its cause remains open, no runtime fix is claimed. The subsequent expanded
Firefox repeat, session 24093, failed its first reload. Inspection still sees
the complete page while automation cannot read the frame, its new-document
instrumentation trace is also absent. The expanded repeat gate remains open.
Diagnostic 85655 proves the reloaded Counter handler and server call still
work, changing 41 to 42 through inspection after the frame failure. An isolated
Playwright 1.63.0/Firefox 155 comparison, session 18579, reproduces the same
failure and successful diagnostic mutation. No physical-pointer or stock
Firefox result during that failure is claimed.
Separately, stock Firefox 157.0 in an isolated profile passes native input:
three preview reloads with real Counter server calls, terminal writes, and
preview hide/reopen. This is a browser control, not closure of the failing
expanded automated repeat or a runtime fix.
The smaller unchanged Start Counter control passes 60 real reloads across
the desktop engines and a Firefox interrupted-process sequence. A reduced
site workflow passes three Firefox runs, but adding editing/toggling/resize
reproduces the original missing-frame failure. Separately, a terminal sizing
race is fixed by sending dimensions with the initial command request. Three
focused Firefox resize/editor runs and the fixture type-check pass. The same
focused workflow also passes Chromium, Firefox and Playwright WebKit on the
updated templates. The larger combined group still fails in Firefox, it is
not accepted and the separate frame-context issue remains open.
The isolation runner now records each terminal feature separately and in
smaller combinations, without inheriting unrelated experimental flags. This
round completed 23 successful Firefox workflows, but the full combined case
failed twice. In a bounded protocol capture, the failed reload destroys the
old execution contexts without reporting a replacement navigation or context.
A passing baseline reports both navigation and new contexts in the matching
interval. This narrows the diagnosis, it does not prove an upstream cause or
close the expanded Firefox acceptance gate. All 21 runner and diagnostic
unit checks pass. Pinned examples, SDK and runtime bytes are unchanged.
Stock Firefox also passes a combined native-input control with terminal
editing, panel toggling, pointer resizing, scrollback, interruption, two
preview reloads, server mutations and editor/source synchronization. Visible
automated Firefox still reproduces the missing-context reload failure, and a
later repeat failed at a terminal toggle. A separate startup attempt reported
no WebAssembly compiler and closed. None is waived. The exact failed-page
native-input check was not completed because app control stalled until the
held test window expired.
Native input exposed a separate splitter focus bug. Both splitters now focus
on pointer input, and the resize test requires that transfer instead of
supplying focus programmatically. Native Firefox verifies both splitter
keyboard controls. The updated resize/editor/reload/server workflow passes
Chromium, Firefox and Playwright WebKit, the fixture type-check and all 24
focused diagnostic tests pass. This integration fix does not close the
intermittent Firefox automation gate or approve the private SDK for release.
The subsequent full combined Firefox repeat on the focus-fixed template passed
twice, then reproduced the original missing-frame-access failure in its third
run. The batch remains failed, no diagnostic click or retry converted it green.
Browser-only streamed iframe controls now pass sixty reloads across the three
desktop engines, verifying direct network and service worker transport. The
full-site current-version test still fails. A separate temporary Playwright
1.61.1/Firefox151 comparison passes thirteen complete combined workflows on
the same fixture and unchanged assertions. A context-initialization change in
the newer browser automation is a concrete regression candidate, not yet a
proven cause. Project dependencies, runtime and release gates are unchanged,
an older-build pass is not a downgrade solution or alpha acceptance. All 28
focused diagnostic/control unit tests pass.
After the thirteen older-version passes, the current-version recheck passes
once and fails its second reload with the same missing context notifications.
Its batch remains failed, the third planned run does not execute. This makes
the version difference repeatable without closing the Firefox launch gate.
Cross-paired tests now narrow the difference to the browser build: current
Playwright with Firefox151 passes three full workflows, older Playwright with
Firefox153 passes once then fails. Stable1.63.0/Firefox155 and today's development
build/Firefox156 both fail the original reload on the current fixture. A
source-level callback model confirms a possible missing-context path, not the
real browser's event conditions or a vendor fix. Expanded SDK-free transport
and history controls pass180reloads, all31focused tests pass. The upstream
report was posted with permission to the existing related
[Playwright issue](https://github.com/microsoft/playwright/issues/43007#issuecomment-5966022708).
No archive patch, downgrade or gate waiver was used.
See [preview control and terminal diagnosis](reports/native-preview-update-control-2026-10-02.md).
See [current predicate acceptance](reports/native-reply-predicate-2026-10-02.md).
The earlier API 7 source separates native agent tools from the legacy default
kernel and emits a checked `./native` browser entry. Fresh private staging
`DxOGGu`, split `GMoY8k` and installed consumer `VhHYSf` pass package checks,
native imports, consumer bundling, public types and offline reinstall. This
pair has not passed browser acceptance or a source-bound release build. The
API 7 packaging recipe still includes legacy assets. See
[native entry packaging](reports/native-sdk-entry-2026-10-02.md).
API 8 now makes the native-only profile the default and the only public-release
profile. Both the package root and `/native` use the explicit-backend agent API.
Private staging `sab3TM`, split `fV56Ia` and installed consumer `buclxh` pass
package installation, public types, native bundling, reproducible packs and
offline reinstall with identical deployment inventories. The package contains
the native compiler catalog, Go/WASM shell and preview host, without QuickJS,
legacy kernel/compiler workers, kernel host or old TLS/HTTP2 runtime folders.
The first complete three-engine pinned example batch passes. The final repeat,
session 62478, also passes all five examples and owner/terminal/agent workflows
in Chromium, Firefox and Playwright WebKit, with unchanged runner hashes and
package, deployment and example identities checked after each browser.
The release recipe now builds only shell support and the two native compilers,
and its 135 unit checks pass. This pair reuses verified compiler outputs, it
is private `0.0.0` with unavailable source binding, not a fresh source-built
alpha. The live site has not switched to it. Missing notices, distribution
review, source-bound release and the expanded full-site Firefox gate remain
open. See [native-only package work](reports/native-only-sdk-2026-10-03.md).
The prior F0X72C Basic restart failure is retained in
[HTTP cancellation evidence](reports/native-http-cancellation-2026-10-02.md).

The earlier private native candidate `gwZhLo`, split as `un5TrK` and installed
in consumer `WYCnzv`. Its two compilers are built from the pinned
`build-inputs/native-runtime-toolchains.json` plan, not copied from a previous
runtime output. The package pair passes reproducible packing, public types in
Bundler and NodeNext, asset setup, consumer bundling, and offline reinstall with
identical deployment bytes. It is not source-bound publication acceptance.
See [current native acceptance](reports/native-current-acceptance-2026-10-01.md).
Both this pair and the prior `qJNd4q`/`8In3tG` pair in `OLepTQ` pass all five
pinned examples in Chromium, Firefox and Playwright WebKit, including the
portable release batch. That is SDK acceptance, not the real-site or
source-bound alpha launch gate. An earlier intermittent
Firefox first-stream failure remains recorded for repeat testing.

These are the active launch gates, all apply to the same final artifacts:

The latest full-site streaming check fixes a premature test click by requiring
the pinned examples' existing client UI before interaction. Three complete
Chromium and three Firefox workflows pass, with both progressive streams.
The locked WebKit build passes once, then crashes during worker startup.
A separate official Playwright 1.63.0/WebKit 26.6 comparison passes three runs
with identical test sources, without proving the crash is fixed. This does
not clear the combined Firefox terminal/reload failure or the launch gates
below. See [streaming readiness and browser evidence](reports/native-site-streaming-readiness-2026-10-03.md).

The same official 1.63.0 release now passes nine expanded full-site terminal
workflows, three per desktop engine. Its complete five-example SDK check passes
Chromium and WebKit, but Firefox stalls at Counter client-module startup.
These are separate matrices, the terminal passes do not clear that SDK failure
or the older intermittent reload failure. Root browser dependencies remain
unchanged. See [broader browser comparison](reports/native-official-browser-broader-2026-10-03.md).

Pre-disposal diagnostics now separate a Firefox project-readiness timeout before
preview mounting from a later Counter interaction failure after its update RPC
completes. Two complete SDK runs pass before the next startup failure, neither
failed case has a proved cause or runtime fix. All 152 release unit checks and
53 focused loader/HTTP/owner checks pass, not browser acceptance. The browser
upgrade remains on hold. See
[startup diagnostics](reports/native-owner-startup-diagnostics-2026-10-03.md).

Consumption tracing reproduces a separate second-stream fetch stall after the
first stream reaches EOF. A combined trace run passes all five examples, not
a fix for that failure. The unchanged installed preview transport passes
sequential mutation and stream controls in all three desktop engines without
Vite or framework code. Next isolate request handling in the native worker
under app load. See
[fetch consumption evidence](reports/native-fetch-consumption-2026-10-03.md).

Native notice input work on 2026-10-03 now fills two of the three text gaps.
wasm-util uses the maintainer's later-added MIT notice, with the later revision
recorded explicitly. glob-to-regex uses Apache's official terms and its original
README attribution. Fresh rebuild `native-notice-rebuild-AM3TB2` preserves both
compiler engine hashes and reports only `napi-wasm@1.1.3` as missing notice text.
Its npm release and pinned upstream tree declare MIT but contain no full notice.
Distribution review remains incomplete. The source-bound private pair then
passes all five pinned examples in all three desktop engines, batch 63275.
Clean archive replay fixes Go Git stamps, random Oxide bundle paths and stale
notice-test dependencies. Independent clean builds now match all runtime,
staging and split package files, including a fresh Node 24.15.0/npm 11.12.1 build.
The npm-built pair passes package/types/offline checks, 139 release checks,
12 extra build/asset checks and 6 installed agent checks. Batch 54689 passes all
five examples and owner/terminal/agent workflows in Chromium, Firefox and
WebKit. An earlier Firefox progressive-stream observation failure remains
recorded and unexplained. This is private source-bound SDK acceptance, not
full-site acceptance or a publication-format alpha. See
[clean source replay](reports/native-clean-source-replay-2026-10-03.md).

- [ ] Real Counter, Basic, Streaming and Router SSR examples pass startup,
  hydration, interaction, live edits and progressive streaming in the site.
  The latest compiler-startup metadata pair passes two complete strict workflows
  per desktop engine in the isolated real-site fixture, six of six. Final
  publication acceptance remains open, earlier receipts do not transfer to
  different runtime bytes.
- [ ] The native development loop and integrated terminal pass supported
  commands, output, input/EOF, interruption, restart and cleanup checks.
  The latest private pair passes all twelve original real-site terminal cells,
  including declared production builds, live edits and restart. This is one
  complete matrix, not repeated terminal reliability or final alpha acceptance.
- [ ] Desktop checks pass in Chromium, Firefox and Playwright WebKit. The preceding
  checked-write pair passes the full Linux ARM64 matrix. The newer proxy-compatible
  pair passes Chromium and Firefox on Mac, but its full WebKit check fails a
  worker startup control. The latest compiler-startup metadata pair passes the
  expanded full Mac check once in every engine, it does not explain the older
  failure. New-source Linux checks, actual x64 CI and final
  publication-artifact checks remain open. Actual
  Safari comparison was waived by the user, no actual Safari pass is claimed.
- [ ] The source-bound alpha pair passes the fresh build, package and hosting
  checks, includes required third-party notices, and has an exact-artifact
  compatibility record. The new native build reports 1 missing notice
  text and incomplete distribution review, publication remains blocked.
- [ ] At least one real TanStack.com production example uses the released
  standalone SDK. Registry installation and production adoption are not yet
  verified. Preserve the lightweight path for examples that do not need a full
  environment. The strict site's passing evidence uses the approved private
  Redact recovery build. Production must also consume that owning renderer fix
  through its normal dependency path, the local test hook is not deployment
  evidence.
- [ ] The exact new SolidJS site's sandbox examples pass against the final
  artifacts. Its repository or directory is still needed. The supplementary
  Solid Start Counter is not proof of that suite.

Older QuickJS results below are historical, they do not close these native
launch gates or substitute for the new SolidJS suite.

## Historical QuickJS candidate

`e4eX3U` is the new source-bound `0.1.0-alpha.0` candidate with the verified
UTF-16 fix. Adoption passes public types, reproducible packing, asset setup and
offline reinstall with identical deployment bytes. Its twelve strict runs and
all per-cycle and aggregate evidence audits pass, three Vite and three Start
cycles in each of Chromium and Firefox. The isolated site's installation uses
the same adoption tarballs and deployment bytes. Its four-example matrix passes
all eight Chromium/Firefox cells and 34 behavior assertions. This is isolated
development integration, not production deployment. The
[site audit](reports/tanstack-four-example-e4eX3U-runbook.md) preserves cancelled
Firefox requests and binds the same package/deployment identities. The shipped
Vite/Start example UI batch passes eight runs, two cycles per app and browser,
including offline resume and same-origin host restart. Its
[audit](reports/sdk-split-e4eX3U-framework-repeat-audit.json) retains aborted
requests and Firefox preview-close stream errors, not a clean-diagnostics claim.
The basic example also passes all four Chromium/Firefox tests, including
edit/run/preview/save/reload/resume and positioned file I/O, in
`test-results/sdk-split-e4eX3U-basic-example`. Both basic reports match strict
acceptance's five package/deployment identities and have no page errors.
See [its candidate record](reports/sdk-split-e4eX3U-candidate.md). Nothing is
release-approved or published to npm. The records below remain historical
evidence and are not acceptance of this new pair.

## Previous source-bound candidate

`JIhQsM` is the source-bound `0.1.0-alpha.0` publication-format package pair.
It includes the packaging fixes and MIT license. Reproducible tarballs, public
types in both resolution modes, Vite consumer bundling and offline reinstall
with identical deployment bytes pass. Its twelve strict Chromium/Firefox
workflows pass, three cycles per app and browser. Per-cycle and aggregate audits
verify byte-exact offline restore, subsequent edits, acknowledged shutdown and
resource cleanup. All deployments match adoption's exact deployment bytes.
Actual Safari remains unverified. The site matrix stopped at Basic Firefox:
Nitro's 30-second reload limit returned 503. Counter passed in both browsers and
Basic passed in Chromium. The original failure is retained while startup
diagnostics are investigated; the site gate remains open.
The next diagnostic preserves native Buffer support while sampling guest
functions. Its initial host startup exposed a missing profile registration,
now covered by runtime-profile tests. This diagnostic is not alpha acceptance.
The shipped standalone basic example passes edit/run/preview/save/reload/resume
and positioned file I/O in Chromium and Firefox, four tests total in
`test-results/sdk-split-JIhQsM-basic-example`. Packaged framework UI acceptance,
including same-origin host restart, passed Vite in Chromium/Firefox and Start
in Chromium. Start in Firefox failed initial hydration after SSR, retaining
`data-hydrated="false"` for the 60-second assertion. The failed report is in
`test-results/sdk-split-JIhQsM-framework-example`; this is a separate open gap
from the site's Vite 8 Nitro startup timeout. No deadline was extended.
The separate private `orDETZ` candidate adds direct UTF-16 Buffer writes. Its
two consecutive site Basic Firefox runs pass all five assertions, including SSR,
hydration, server functions and live edits, with no page/console errors.
These runs do not accept JIhQsM or resolve its packaged
Firefox hydration failure. The new candidate is not release-approved.
The orDETZ packaged Start Firefox workflow now also passes cold hydration,
server calls, edits, positive/negative test scripts, offline dependency resume,
further edits and same-origin host restart. Evidence is in
`test-results/sdk-split-orDETZ-framework-start-firefox`. The full packaged
Chromium/Firefox matrix now passes eight runs, two cycles per app and browser,
without retries, in `test-results/sdk-split-orDETZ-framework-repeat`. Results
from JIhQsM are not transferred to it. Strict byte-exact cleanup checks and
final source-bound release acceptance remain open.
Identities and evidence are in [the candidate record](reports/sdk-split-JIhQsM-candidate.md).
The packages are not published or release-approved. Earlier candidates below remain
regression evidence, not approval for this pair.

## Previous candidate evidence

`ai9akL` is the private API 6 split SDK/runtime candidate. It fixes compiler
dependency resolution so npm and pnpm use the pinned direct dependency graph.
Version, input-hash and package-root checks remain enforced. The isolated site's
pnpm installation and public asset setup pass without dependency-version
overrides. A local tarball override only locates the unpublished runtime package.

Fresh npm adoption passes installation, 153-file deployment verification and
Vite bundling. All twelve WASM inputs match the earlier p11JMm staging bytes.
The compatibility checker accepts the explicit API 5-to-6 change and reports no
removed runtime paths, hosting-contract change or profile change. These checks
are not release approval.

Its twelve-run Chromium/Firefox app batch passes, three complete workflows per
app and browser. The strict paired report check passes in
[the API 6 batch report](reports/framework-split-ai9akL-desktop-batch.json).
The isolated TanStack.com matrix stopped at Counter Chromium: SSR, hydration,
server-function and live-edit assertions all passed, but eleven owner-page
analytics requests failed COEP checks. The failed report is retained in
`reports/tanstack-parity-ai9akL/start-counter-chromium.json`. Development analytics
configuration now follows the site's production-only convention without weakening
isolation or filtering errors. The retry in
`reports/tanstack-parity-ai9akL-dev-analytics` passes all eight runs and 34
behavior assertions across Counter, Basic, Streaming and Router SSR in Chromium
and Firefox. All eight reports validate and both servers stopped. Fatal
page/console errors and failed HTTP responses are empty. Firefox Counter and
Streaming each retain two navigation-cancelled client-module requests. This is
an isolated development integration, not production deployment.
Exact identities are in
[the split-package migration record](reports/tanstack-split-package-migration.md).

The frozen private `ai9akL` candidate also passes the strict save/resume batch:
three Vite and three Start cycles in each of Chromium and Firefox, twelve total.
All twelve per-cycle audits pass with byte-exact restore, blocked external
dependency requests during resume, further edits, acknowledged shutdown and
resource cleanup. The [strict evidence report](reports/sdk-split-ai9akL-strict-evidence.json)
binds both package tarballs and each cycle's exact deployment manifest. This does
not accept later source changes or a publication-format rebuild. Safari remains
unverified.

Previous split candidate `MhXC2w` passed all twelve packaged Vite/Start workflows,
three rounds per app in Chromium and Firefox. Its
[paired evidence](reports/framework-split-MhXC2w-desktop-batch.json) does not
accept the newer API 6 candidate. Older all-in-one `p11JMm` passed the
[isolated four-example site matrix](reports/tanstack-four-example-p11JMm-runbook.md),
eight runs and 34 behavior assertions. That is not split-package or production
deployment evidence.

## Historical QuickJS launch checks

These checks describe the historical QuickJS candidates. They are not native
alpha acceptance and do not replace the active launch gates above.

- [x] **Real apps work on the current package pair.** Strict e4eX3U Vite and representative TanStack
  Start pass preview, SSR, hydration, server functions and live edits in repeated
  Chromium/Firefox workflows. Supported versions and feature limits remain
  explicit. Reopen this gate if the package pair changes; the separate desktop
  gate still requires Safari.
- [x] **The development loop works on the current package pair.** Load a project, install supported
  dependencies, edit files, run supported scripts and tests, inspect output,
  save, reload the owner and resume in a fresh kernel. Require restored source,
  server data, installed packages and cache bytes, blocked and recorded external
  dependency requests during resume, further edits/interactions, and acknowledged
  shutdown. All twelve strict publication-format runs and the exact-artifact
  aggregate audit pass in Chromium/Firefox. Reopen this gate if the pair changes.
  Offline workspace restore does not mean offline hosting or live-process restore.
  These two gates are supported by the current e4eX3U pair's
  [strict aggregate audit](reports/sdk-split-e4eX3U-strict-audit.json), not results
  transferred from an earlier pair. Packaged example UI acceptance, the site
  matrix and the remaining release gates are separate and still open.
- [ ] **Desktop browsers work.** Repeat both complete workflows in Chromium,
  Firefox and actual Safari with clear unsupported-capability errors. Current
  Chromium/Firefox repeated workflows pass. Actual Safari acceptance is still open.
  The user deprioritized further Safari comparison work, so it is not the next
  experiment, but no Safari pass is claimed. Playwright WebKit and diagnostic
  runs do not establish actual Safari acceptance. Retained ordinary failure:
  [p11JMm Safari evidence](reports/safari-p11JMm-final-desktop-candidate.json).
- [ ] **Other developers can adopt it.** Ship the standalone public API, types,
  install/hosting docs, working frontend/full-stack examples, MIT project license,
  supplied third-party notices and an honest exact-artifact compatibility matrix.
  Split package examples, npm consumer setup and pnpm site setup work. Complete
  final paired-package acceptance, fresh-source build verification, reproducible
  packing, release review and registry-install verification remain open.
  Compatibility and publication-identity verifiers do not approve private
  candidates or replace workflow acceptance.
  Source documentation now states that snapshots include secrets saved in
  workspace files and the public package README includes isolation limits.
  These corrections are not in the frozen e4eX3U candidate. The source command
  adapter now rejects unsupported `--offline`, `--prefer-offline` and
  `--frozen-lockfile` flags before installation, with 27 command tests passing.
  This runtime change also needs a new candidate and acceptance before release.
  Installation reads npm lockfiles, not pnpm/yarn/bun lockfiles; `ci` remains
  an installer alias rather than full npm CI behavior.
- [ ] **TanStack.com uses it.** At least one real interactive production example
  must use the released standalone SDK. First repeat Counter, Basic, Streaming
  and Router SSR against the current paired artifacts in the isolated site.
  Production dependency adoption and deployment remain open. Simple inline
  examples should keep their lightweight path. The original dirty site checkout
  remains untouched.

## Historical release and licensing notes

The frozen source extraction now builds all six engines, shell, HTTP/2, TLS,
SDK staging and split packages without copied runtime outputs. Its fresh
consumer installs both packages, prepares 152 verified deployment files and
bundles with Vite. See [the source-build record](reports/source-extraction-2026-09-23.md).
This uses installed pinned toolchains and predates the latest packaging changes;
it is not final source-bound publication or browser acceptance for the new build.

Source now removes installation-path comments from generated compiler workers
while preserving legal notices. Two independent installation directories produce
identical compiler assets in the regression test. The frozen candidates remain
unchanged. Twelve compiler/setup/package-boundary tests pass.

The new private split `nTFTjj`, combining clean-source staging with the current
packaging helpers, passes reproducible packing, Bundler/NodeNext public types,
Vite bundling and offline uninstall/reinstall with identical deployment bytes.
The older `hBp91J` correctly fails the new deployment-identity check. These are
adoption results, not browser acceptance or source-bound release approval.
See [the adoption record](reports/sdk-split-nTFTjj-adoption.md).

The MIT experimental source is published at
[github.com/TanStack/container](https://github.com/TanStack/container).
The initial source commit is `8e0f57bd29978810811fa995df63e9b4d1d63539`.
No npm packages have been published. Source publication does not approve the
alpha or replace exact-package workflow verification.
The latest outside-sandbox npm authentication check returned E401, so npm
authentication is still required before publication.

The current packages have public alpha metadata but remain unpublished. Complete the required
prepublication workflow and source/package reviews, publish source and packages, then verify a fresh
registry install and the actual published identities. Keep final tarballs, source
archive, acceptance evidence and external attestations together. Old all-in-one
release commands do not establish that split-package release wiring is complete.

Source follow-ups after `ai9akL` now preserve MIT metadata and the root license
even in private development packages. Split packaging also verifies the source
archive bound by release staging before copying current helpers, with a second
check after bundling. Focused tests pass; these changes are not in `ai9akL`.
An explicit `--publication-candidate` split build now prepares final alpha
metadata before testing. It requires verified provenance and matching MIT
licenses; private builds remain the default. This prepares publishable format,
not release approval. The reviewed release record and final acceptance are still
required. Preview-host setup also retains its typed routes and headers API.

Our project license is MIT. Preserve dependency notices in package and deployment
outputs, and document unresolved upstream attribution questions. This is not a
requirement to petition authors or reproduce an upstream binary byte for byte.
No maintainer inquiry has been sent. Historical details:
[Rolldown notice review](reports/rolldown-rust-notice-review.md).

## Historical QuickJS next actions

1. Preserve completed e4eX3U acceptance: adoption, twelve strict workflows,
   eight site cells, eight framework-example runs and four basic-example tests.
   Keep cancellation/preview-close diagnostics in the evidence. Do not transfer
   acceptance between package pairs or to newer source changes.
2. Resolve the source-publication difference recorded in
   [the reconciliation report](reports/e4eX3U-source-reconciliation-blocked.md).
   The attempted copy was denied before changes. Do not retry it without the
   requested approval. The unintegrated native decoder is not needed to run apps.
3. Finish split release wiring and final source/consumer verification, then
   replace temporary local tarball references with released dependencies and
   verify a real production example. Keep the unresolved desktop gate visible.

Production hosting still needs a concrete choice. A cross-origin host iframe
alone does not prove Start can run below a non-isolated docs page. Retained tests
isolate the top-level owner too. See the
[production hosting findings](reports/tanstack-production-hosting-gap.md) for
isolated top-level route/origin options and checkpoint implications. Development
analytics gating does not resolve the production topology.

The isolated site's explicit production asset preparation now uses public SDK
APIs, requires configured owner/preview origins and package identities, and emits
bound deployment assets/configuration without activating routes. Three regression
tests pass for options, wrong identities, preserved hosting policy and asset
hashes, and overwrite refusal. This is preparation, not production deployment.

Build: [BUILDING.md](BUILDING.md). Public setup:
[SDK package guide](src/sdk/NATIVE_PACKAGES.md). Publication verification:
[split attestation guide](scripts/sdk-split-publication-attestation.md).

## Scope and protections

Target common JavaScript and TypeScript projects, not complete Node or operating
system compatibility. Phones, native addons, arbitrary binaries and uncommon
framework features are outside the alpha gate.

Continue ordinary functional work on owned fixtures and public packages:
installation, cancellation, worker lifecycle, filesystem persistence, Node API
behavior, framework builds, previews and save/resume. Preserve permission checks,
isolation boundaries, resource limits, cancellation, accounting and warnings.
Do not extend deadlines, remove resume caches, serialize app operations or
silently substitute dependencies to make a test pass.

Security research, sandbox escapes, exploit development and adversarial probes
are deferred. Functional tests do not prove safe execution of arbitrary hostile
code. If a test is blocked, document what is unverified and move to an independent
functional requirement, do not disguise the same experiment.

Run one heavy browser workload at a time. After two experiments that do not
change the implementation decision, choose a different approach. Every
experiment must produce a fix, an architectural decision or a documented limit.
