# Browser sandbox feasibility spike

## September 11: public VM contexts and corrected memory accounting

The worker kernel now exposes `vm.createContext`, `isContext`, `runInContext`,
and `runInNewContext`. Child realms retain live sandbox objects, separate
intrinsics, raw values and promises, native async/await, ALS, and shared runtime
deadlines. A native context factory transfers ownership to QuickJS GC and
removes private capabilities. A native job pump avoids host-wrapper ownership
of borrowed child contexts. Creation is capped at 64 attempts per execution.

The public corpus has 46 Node comparisons and one explicit policy difference:
child-generated imports cannot use the workspace module loader even where
Node permits them. All 47 native checks pass. VM modules, compiled caches,
`compileFunction`, custom import callbacks, after-evaluate microtask draining,
and Proxy-sandbox conformance remain open.

Accurate resource limits exposed a defect in the pinned QuickJS WASM allocator.
Its usable-size function returned zero, so retained allocations and reallocations
were undercounted. A 2 MiB test retained 8 MiB before the fix. The engine now uses
Emscripten `malloc_usable_size`, and the same test rejects allocations before its
budget is exceeded. Earlier compatibility passes remain execution evidence,
but did not prove aggregate heap enforcement. See the
[negative control](reports/allocator-accounting-before.json) and
[corrected accounting](reports/allocator-accounting.json).

Allocation pressure also found two cleanup bugs in the pinned engine: a failed
raw context remained on the GC list, and failed Proxy initialization could free
a consumed constructor twice. Both are fixed. The 1,025-point native
AddressSanitizer sweep passed, including 458 failed allocations and 567 successful
creations. The WASM sweep passed with 460 failures and 565 successes. Every
attempt recovered with a subsequent evaluation. All three desktop test engines
also passed the accounting and 1,025-point allocation sweep. This is not
exhaustive allocator or security certification, and the guest budget is not a
browser-process memory ceiling.

With the corrected allocator and unchanged workload limits, Webpack's SHA-256
configuration builds in Chromium, Firefox, and Playwright WebKit. Default
Webpack still stops at guest WebAssembly. The first complete package/app rerun
retained 20 direct passes, six adapted passes, and 13 gaps per browser. The
subsequent stream batch found an actual 16 MiB default-budget failure: each
Node API facade embedded another copy of the core library. The runtime cache
avoided repeated initialization but not repeated parsing. Facades now import
`node:process` and reuse its initialized core, with a unit test enforcing one
source copy. All 18 focused browser checks passed after the fix, including
child allocation rejection after guest startup and recovery.

The complete follow-up passed 771 checks in five separate launches, with no
skips, flakes, or harness failures. Every engine reports 20 direct package
passes, six adapted passes, and 13 gaps. The four interactive apps and four
separate browser-native runtimes passed in every engine. The
[current workload report](reports/current-workload-summary.md) records matching
source/build fingerprints and points to
`reports/batched/2026-09-11T09-11-09.863Z-77542/`. Both TypeScript checks and
36 unit tests passed. `npm run check` also passed: 85 positive end-to-end tests,
six expected-failure controls, 37 production tests, and 54 feasibility tests.
End-to-end and production each retain two documented skips.

All 16 desktop lifecycle checks passed, including installed Chrome. The isolated
three-cycle WebKit run peaked at 1,663 MiB and settled at 1,662 MiB after a
60-second idle, below the unchanged 2,048 MiB gate. The
[desktop gate report](reports/kernel-gate.json) now records the tested artifact
fingerprints. This remains a substantial footprint and a bounded local test,
not long-session or installed Safari/Edge, other OS, or phone certification.
The lab at `http://127.0.0.1:4187/sandbox.html` serves the rebuilt engine and
runtime artifacts; the served WASM hash was verified.

The default sync WASM hash is
`dd479356075d63da6f56129ff4979c4e83a1cc4362c6bfcfc30916d200f52995`.

[The next guest-WASM probe](reports/guest-wasm-recon.md) records a pinned
interpreter candidate and the resource/interop controls it needs. No guest
WASM support was added by that inspection.

## September 11: candidate live-global bridge

The separate QuickJS candidate now has a live sandbox/global bridge. It retains
guest object identity and separate realm intrinsics without copying properties
or using a browser-realm Proxy. An engine exotic object handles global access,
while lexical bindings remain separate. A regular JavaScript Proxy cannot
represent Node's differing sandbox and hidden declaration descriptors without
violating Proxy invariants.

The Node comparisons caught function hoisting bypassing the bridge, writable
shadows of intrinsic constants, incorrect accessor receivers, prototype cycles,
and declaration/lexical conflicts. They also found that a compiled runner called
from another realm could instantiate its bytecode against the caller's globals.
Runners now use the bytecode's retained realm. Global-key merging uses a bounded,
interruptible hash lookup instead of a quadratic scan.

All 42 bridge scenarios match Node, including code-generation restrictions,
catchable deadlines, callbacks into the parent realm, and recovery. Each browser
worker repeats these and the 39 engine primitive checks three times. Chromium,
Firefox, and Playwright WebKit passed the 75-test focused regression run. The
10 native script comparisons, both TypeScript checks, and 34 unit tests passed.
See [the focused report](reports/context-globals-summary.md) and
[native comparisons](reports/context-globals.json).

The candidate is `public/quickjs-als-oz`, built with the same Oz optimization as
the default engine. Its WASM hash is
`ce0f9ee529ddd99fbfdf71cb0f368f15afa118da8c2510e52bbc60e4b7b3df3c`.
The default sync and Asyncify artifacts, lab distribution, and prior 621-check
workload report remain unchanged. This turn did not rerun that full suite or
the desktop memory gate against the candidate.

Public `vm.createContext`, `runInContext`, context disposal, module-loader
policy, and context quotas are not integrated yet. Webpack's SHA-256 workload
remains blocked there. Proxy-sandbox conformance and systematic allocation-failure
tests also remain open. These passes do not establish full Node compatibility,
a production security boundary, or installed Safari/Edge and other OS support.

## September 11: context policy and cross-context deadlines

The engine now has a one-way, per-context string-code-generation policy.
It rejects guest eval and every Function constructor type with that realm's
EvalError, while still allowing host script compilation and execution. This
includes Node's rejection of non-string eval calls under the policy. The
initialization function is removed before kernel guest code runs.

The context probes found two deadline defects. A timed script could call into
another realm without carrying its local budget. Nested deadlines could also
expire together, allowing an inner catch to hide the expired outer budget.
Budgets now belong to the shared runtime and unwind to the outermost expired
owner. In the saved 100-trial comparison, the old engine swallowed every outer
timeout; the fixed engine interrupted the outer call every time, matching Node.
See [before](reports/context-deadline-before.json) and
[after](reports/context-primitives.json).

The shared corpus has 39 engine checks, including Node comparisons for policy
and deadlines. It passed three fresh-runtime rounds in each of Chromium,
Firefox, and Playwright WebKit. The public vm.Script API has an additional
equal-deadline regression in bundled and unbundled execution. The focused
browser run passed 72 tests.

The clean full run passed 621 workload/API checks across four separate
launches, with no skips, flakes, or harness failures. Every engine retained
20 direct package passes, five adapted passes, and 14 gaps. All four interactive
apps and all four separate trusted browser runtimes passed. The
[current report](reports/current-workload-summary.md) records the tested hashes
and points to `reports/batched/2026-09-11T07-47-48.561Z-65168/`.

Both TypeScript checks, 34 unit tests, 85 positive end-to-end checks plus six
expected-failure controls, 37 production checks, and 54 feasibility checks
passed. End-to-end and production each retain two explicit skips. All 16
desktop checks passed, including installed Chrome. The isolated three-cycle
WebKit memory run peaked at 1744 MiB and settled at 1743 MiB after 60 seconds,
below the unchanged 2048 MiB gate. This remains a substantial footprint, not
a long-session certification. Safari, Edge, other operating systems, and phones
remain unverified for this revision.

The earlier broad run was deliberately stopped to fix the deadline race.
The runner now forwards SIGINT so Playwright closes its browsers and server;
a cancellation probe verified exit 130, an interrupted report, and a released
server port. Both interrupted runs remain separate from the clean evidence.

This does not yet implement vm.createContext or its live sandbox-object/global
bridge. Webpack's SHA-256 configuration still stops there, while default
Webpack stops at guest WebAssembly. These engine checks are prerequisites,
not new package compatibility passes. Run `npm run probe:context-primitives`
for the fast native probe; the full workload batches include its browser rounds.

## September 11: symbolic links and the next Webpack barrier

The new filesystem/runtime batch passed 141 checks across Chromium, Firefox,
and Playwright WebKit. It includes 36 new link checks, with Node comparisons
for relative, absolute, dangling, and cyclic links; stat/lstat; alias directory
listing; writes, copies, rename, and deletion; callback/promise APIs; encodings;
and ALS. Linked package imports, CommonJS/ESM identity, browser compilation,
read-only authority, and checkpoint restoration have separate checks.

The complete follow-up passed 612 checks in four separate launches, with
matching runtime-source, engine, builtin, and guest Web API fingerprints. No
checks were skipped or flaky. All three engines retained 20 direct package
passes, five adapted passes, and 14 gaps across 39 probes. All four interactive
apps and all four trusted browser runtimes passed. The
[current report](reports/current-workload-summary.md) points to the dated raw
results under `reports/batched/2026-09-11T06-56-27.820Z-55391/`. These are
completed experiments, not 612 claims of complete package compatibility.

Earlier exploratory results remain separate. One test was interrupted by a
dev-server reload during an edit. A later package batch was stopped to fix
the original runtime's metadata contract before the clean four-batch run.

The final build passed both TypeScript configurations, 34 unit tests, 85
positive end-to-end checks plus six expected-failure controls, 37 production
checks, and 54 feasibility checks. End-to-end and production each retain two
explicit skips. All 16 desktop checks passed, including installed Chrome.
Three WebKit workflow cycles peaked at 1738 MiB renderer RSS and settled at
1737 MiB after 60 seconds idle, below the unchanged 2048 MiB gate. This is
still a large footprint, not a long-session memory certification. Installed
Safari, Edge, other operating systems, and physical phones remain unverified.
The lab on port 4187 serves the rebuilt output. Source and artifact fingerprints
still match the workload evidence after the final build.

Link resolution lives in the authoritative filesystem, before dot-dot
processing. It is capped at 40 followed links and rejects walking above the
virtual root. Links count toward entry quotas, and their target bytes count
toward the byte quota. Checkpoints now use version 3 and retain links and
empty directories; versions 1 and 2 remain readable. Invalid restores and
quota failures leave existing state unchanged.

Package extraction refuses existing links in every destination component,
including the final filename. Browser tests verify that both a redirected
package directory and a linked package.json fail without overwriting another
workspace file or committing a partial install. Another test restores a linked
entrypoint after a full page reload and an empty package-install operation.

Runtime modules and the compiler use physical paths for module identity.
Relative imports therefore resolve from the real module's directory. The
original native runtime's metadata contract was updated for the shared Stats
constructor, with a dedicated regression test. Stats metadata is still minimal.
Descriptors, file streams, permissions, timestamps, complete trailing-slash
behavior, link-retargeted watches, and preserve-symlinks flags remain gaps.

Default Webpack still fails at its MD4 WebAssembly module. The SHA-256 probe
now gets past enhanced-resolve's readlink call and reaches node:vm contexts.
The pinned Webpack parser creates its magic-comment context with string and
WASM code generation disabled. Neither configuration is a compatibility pass.

The initial host-side `scripts/probe-context-primitives.mjs` experiment confirmed that
the patched QuickJS engine supports separate globals and intrinsics, explicit
shared object identity, persistent lexical bindings, and cross-context ALS
through its shared job scheduler. It also found a mismatch: removing the
Eval intrinsic disables host evaluation too, while Node still allows
runInContext when guest string code generation is disabled. The follow-up
above addresses that policy gap and adds browser-hosted engine checks. The
public node:vm context API remains unimplemented.

The new batch runner checks that every workload spec is included exactly
once, stores each run separately, and stops on test failure. Combined reports
check source and artifact fingerprints and reject duplicate tests. Batching
does not fix the previously reproduced single-launch WebKit lifecycle failure.

## September 11: Node streams and immediate callbacks

All 168 stream and immediate checks passed across Chromium, Firefox, and
Playwright WebKit. The separate 246-check workload run retained every previous
package pass and added React's Node streaming SSR. Each engine now reports
20 direct package passes, five adapted passes, and 14 gaps across 39 probes.
The extra gap is the new Webpack SHA-256 diagnostic, not a lost prior pass.
All four interactive apps and all four separate browser runtimes still pass.
React's Node streaming case is now a required regression baseline.

The remaining 162 core-API checks also passed. The combined
[current workload report](reports/current-workload-summary.md) contains all
576 unique checks from three separate launches, with matching recorded engine,
builtin, and guest Web API fingerprints. The report generator rejects overlaps
and mismatched or absent build metadata. The earlier single-run WebKit
test-browser lifecycle failure remains unresolved and is not erased by this
aggregate result.

The rebuilt app also passed 25 unit tests, 82 positive end-to-end checks plus
six expected-failure controls, 37 production checks, and 54 feasibility checks.
End-to-end and production each retain two explicit skips. Both TypeScript
configurations pass. The rebuilt engine/builtin/Web API fingerprints match the
workload evidence, and the lab at port 4187 serves the updated build.

All 16 desktop lifecycle checks passed, including installed Chrome. Three
WebKit kernel workflow cycles peaked at 1787 MiB renderer RSS and settled at
1786 MiB after 60 seconds idle, below the unchanged 2048 MiB gate. That is
about 1.75 GiB, still a substantial footprint. These local macOS results do
not certify installed Safari, Edge, other operating systems, or phones. Raw
gate results are in `reports/kernel-gate.json` and
`reports/memory-kernel-repeat-kernel-gate.json`.

The guest now uses readable-stream 4.7.0 for Node Readable, Writable, Duplex,
Transform, PassThrough, pipeline, finished, and async stream operators.
The build binds its scheduler, Buffer, and EventEmitter to the existing guest
implementations. Node stream promises and constructor identities are shared
between bundled and runtime-loaded code.

WorkerKernel stdout and stderr are real writable streams. Their byte transport
preserves split UTF-8 and does not add newlines to writes. Console and stdio
share a 1 MiB output quota. Failure diagnostics are appended separately and
still need their own bound. Other backends reject stdio writes explicitly.
There is no stdin or pseudo-terminal device; tty.isatty returns false and
terminal construction fails explicitly.

Readable, writable, and duplex Web Stream adapters stay inside QuickJS. Tests
found and corrected lost duplex options, an unwanted abort on clean destroy,
premature-close error mapping, and byte queues that counted chunks instead of
bytes. Pure Node streams also run without optional Web APIs. The build must use
abort-controller's implementation, not its browser entrypoint that expects
ambient browser globals. Third-party notices retain every bundled package
version, including multiple readable-stream versions used by other dependencies.

The kernel has a separate immediate queue, capped at 128 pending callbacks.
Callbacks retain ALS context, run in FIFO order with microtasks between them,
support cancellation and ref/unref, and yield to the host between dispatches.
Callback errors, deadlines, and disposal use the existing execution boundary.
This is not a complete Node event loop or an exact timer-versus-immediate
ordering guarantee.

New package probes exercise React's Node renderToPipeableStream and Webpack's
public SHA-256 output-hash setting. The unchanged default Webpack probe remains
separate. No workload package source is patched to get past a failure.
Default Webpack now stops at its MD4 WebAssembly module. The SHA-256 probe
gets farther, to enhanced-resolve's missing fs.readlink operation. Neither
is reported as a Webpack compatibility pass.

Remaining stream gaps include complete adapter option and Web Stream state
inspection parity, BYOB adapters, and exact write-promise scheduling. File
streams and descriptors are separate filesystem work. Guest WebAssembly,
native addons/processes, and arbitrary browser package installation remain
open requirements. The existing dependency audit findings are not resolved
by adding stream support.

## September 10: filesystem mutations and directory checkpoints

The filesystem, module-loader, and runtime slice passed all 105 checks across
Chromium, Firefox, and Playwright WebKit. The 27 filesystem checks compare
bundled and runtime-loaded guest operations with Node, then test read-only
authority, checkpoint restoration, quota failures, and recovery. Raw results
are in `reports/filesystem-browser-results.json`.

The follow-up covered every current workload test in two separate runs:
240 package/app/runtime/filesystem experiments and 162 core-API checks, all
with normal browser launch settings and no harness failures. Each engine
retained 19 direct package passes, five adapted passes, and 13 gaps. All four
interactive frameworks and all four separate browser runtimes passed. Reports
are in `reports/filesystem-workloads-summary.md` and
`reports/filesystem-core-summary.md`. This does not fix or supersede the
single-run WebKit lifecycle failure recorded below.

The build, 25 unit tests, 54 feasibility checks, and 37 production checks passed.
End-to-end testing passed 82 positive checks and six expected-failure controls.
Production and end-to-end each retain two explicit skips. Checkpoint reload
and package staging now preserve empty directories on all three engines.

All 16 desktop lifecycle checks passed, including installed Chrome. Three
WebKit kernel workflow cycles reached about 1742 MiB renderer RSS and settled
at 1740 MiB after 60 seconds idle, below the unchanged 2048 MiB gate. The memory
footprint is still substantial. These macOS checks do not certify installed
Safari, Edge, other operating systems, or phones. The lab at port 4187 has been
rebuilt and responds successfully.

Directories are now stored explicitly, including empty ones. Sync, callback,
and promise entry points support mkdir, readdir/Dirent, rename, rmdir, recursive
rm, unlink, append, copy, and truncate for the tested operations. Write flags,
byte views, and Buffer encodings are covered. Promise and callback operations
retain ALS context. Directory unlink accepts either macOS's EPERM or Linux's
EISDIR; the test does not erase other error differences.

Guest writes require an existing parent directory. Host editing tools can
still create parents. Mutations validate quota and destination constraints
before changing storage. The 16384-entry quota now counts files and non-root
directories. Version 2 checkpoints preserve empty directories and still read
version 1 snapshots. Package installation stages the full snapshot instead of
discarding empty directories.

Filesystem entry points share one guest Dirent constructor without a circular
import. The CommonJS builtin loader also caches in-progress module exports,
with a regression for cycles and failed initialization retries. Runtime-loaded
modules now receive the guest Node global and Buffer aliases before execution.

Webpack gets past filesystem imports and the missing global alias. Its next
observed failure is process.stderr.isTTY, because process output streams are
not implemented. This is still a package compatibility gap, not a Webpack pass.

Remaining filesystem gaps include descriptors, symlinks, file streams,
permissions, timestamps and full Stats objects, abortable I/O, and complete
relative-path and callback-argument parity. Modes, flush, and abort signals
on writes reject explicitly. No complete Node filesystem claim is made.

## September 10: compiled guest scripts and portable Node core

The expanded matrix completed 371 of 372 checks. All 63 guest-script checks
and 36 path, querystring, and Buffer checks passed on Chromium, Firefox, and
Playwright WebKit. Chromium and Firefox each recorded 19 direct package passes,
five adapted passes, and 13 gaps. WebKit recorded the same passes and 12 gaps;
its esbuild-WASM guest experiment never ran because navigation timed out.
The report retains that failure rather than filling it with a previous result.

The worker-owned VM now compiles `node:vm` scripts into QuickJS bytecode and
runs them in the existing guest realm. This is real compile-once execution,
not a host eval or promise-chain transform. Script results retain object and
promise identity, global lexical bindings persist, and local script deadlines
are catchable without overriding the outer execution deadline or heap quota.
The native comparison passes nine script cases and the existing 34 ALS cases.

This is a subset of node:vm. Separate contexts, code caches, VM modules,
compileFunction, and dynamic-import callbacks remain unsupported. Stack
formatting is QuickJS, and complete offset and argument-validation parity is
not established. `patches/quickjs-engine.patch` records the combined engine
changes; the older ALS-only patch is retained for history.

Pinned Node 24.15 path and querystring source now runs inside the guest, with
source provenance and MIT notices retained. Windows path helpers are real
implementations, while the virtual process still uses POSIX paths. matchesGlob
is explicitly unsupported. The shared Buffer decoder now handles incomplete
UTF-8 prefixes like Node. Its build-time patch checks the exact dependency
source hash and does not change node_modules or guest application packages.

Differential tests cover malformed query strings, custom codecs,
prototype-sensitive keys, Windows and POSIX paths, and a Buffer corpus with
every one- and two-byte sequence plus longer boundary, random, and sliced
inputs. The loader also now treats `require('.')` and `require('..')` as
relative directory requests. Each correction has regression coverage.

The broad regression run found an outdated upstream-test reference, not a
failed path operation: the reference removed Node's Windows helpers, so it
expected 263 assertions while the guest correctly ran 267. The reference now
keeps those helpers. The unchanged upstream sources still report their 11
explicit skipped groups. All 54 feasibility checks pass after rebuilding.
The unit, end-to-end, and production runs passed 17, 82 positive checks plus
six expected-failure controls, and 37 checks respectively. End-to-end and
production each retain two explicit skips.

All 16 desktop kernel checks passed on Chromium, Firefox, Playwright WebKit,
and installed Chrome with the normal launch settings. Three complete WebKit
kernel workflow cycles peaked at 1707 MiB renderer RSS and settled at 1706 MiB
after 60 seconds idle, below the unchanged 2048 MiB gate. These are local macOS
results, not certification of Safari, Edge, other operating systems, or phones.

Webpack now progresses past vm, querystring, Windows path handling, and bare-dot
module resolution. Its next observed blocker is `constants` in graceful-fs.
It remains a compatibility gap. No new full-framework or bundler pass is
claimed from these API checks.

### WebKit test-browser lifecycle failure

The navigation failure occurred on WebKit's 90th test, before guest execution.
The local server still returned HTTP 200 in about 1 ms. A live sample of the
test browser showed 90 dispatch threads blocked in AppKit's
`NSAnimation _runBlocking`, reaching the dispatch thread soft limit. The new
renderer was idle, with no JavaScript execution in its sampled stack. The
retained trace has no network events for the stalled page.

`node scripts/probe-webkit-pages.mjs` reproduced the failure on page 90 using
only isolated blank data-URL pages, with no lab, QuickJS, package, compiler,
worker, or network request. The `no-window-animation` diagnostic variant
completed 110 pages. That variant disables native window animations through
arguments to its own browser process. It does not change system settings,
application code, or the default workload and desktop gates. It is a diagnostic
control, not a shipped fix or proof about Safari. The normal launch still has
the reproducible failure.

Evidence is retained in `reports/webkit-pages-default.json`,
`reports/webkit-pages-no-window-animation.json`, the two
`reports/webkit-navigation-stall-*-sample.txt` files, and
`reports/webkit-navigation-stall-trace.zip`.

## September 10: shared Node APIs and ESLint

The expanded matrix passed 269 of 270 checks, including all 57 new Node-core
checks. All package experiments completed on Chromium, Firefox, and Playwright
WebKit, each reporting 19 direct passes, five adapted passes, and 13 gaps. The
last WebKit resolution check timed out in page.goto before guest execution.
Twenty traced navigation/resolution repeats passed afterward, but the stall's
cause remains unresolved. The full-run report retains that harness failure;
future failures retain Playwright traces. No timeout was increased or assertion
removed to create a pass.

That run is retained in `reports/workload-before-guest-vm-matrix.json` and
`reports/workload-before-guest-vm-browser-results.json`.

The wider regression run passed 16 unit tests, 82 positive end-to-end checks
(plus six expected failures and two skips), 37 production checks (two skips),
and 54 feasibility checks. All 16 desktop kernel checks passed across Chromium,
Firefox, Playwright WebKit, and installed Chrome. Three complete WebKit kernel
workflow cycles peaked at 1688 MiB renderer RSS and settled at 1686 MiB after
60 seconds idle, below the unchanged 2048 MiB gate. This is local macOS evidence,
not certification of Safari, Edge, other operating systems, or phones.

The rebuilt lab action also completed and downloaded all 37 workload results,
with the same 19 direct passes, five adapted passes, and 13 gaps. Runtime-loader
discovery was refreshed separately in `reports/runtime-loading-discovery.json`;
it does not change the compatibility baseline. Its first blockers include
node:vm for Webpack, node:http for Express, node:tty for several build tools,
guest WebAssembly for Astro, and incomplete prepared assets for SQLite and
esbuild-wasm.

The unchanged ESLint Node entrypoint now performs linting and autofix inside
QuickJS. Its input is edited, repeated, and restored against the Node reference.
Webpack now uses runtime loading too, and reaches a missing `node:vm` import
instead of failing while eagerly bundling unrelated dependency paths.

The shared core adds tested utility and assertion functions, synchronous hashes
and HMAC, random byte/UUID/integer APIs, callback filesystem operations, monotonic
timing, and user timing marks/measures. Runtime modules and bundled execution use
the same definitions. Buffer identity is shared across the guest compatibility
libraries. Third-party versions and notices are retained in
`public/kernel-runtime/THIRD-PARTY-NOTICES.txt`.

Hashing executes inside QuickJS using the pinned JS implementations. Randomness
comes from the browser CSPRNG as copied bytes, not a browser object or a weak
fallback. Host calls are capped at 65536 bytes, public requests at 1 MiB, and total
random output at 4 MiB per execution. This is a tested subset of the
[Node crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html), not a full
crypto implementation or security certification. Hash copies, most hash options,
encryption, signatures, key objects, TLS, subtle crypto, and timingSafeEqual are
not implemented.

User timing delivery uses a shared batch that inherits the first queued event's
ALS context. Node comparisons caught and corrected an initial implementation
that retained observer-construction context instead. Entries and observer queues
are capped at 1024, active observers at 128. Node event-loop phase ordering,
resource timing, histograms, and the rest of perf_hooks remain separate work.

OS identity describes the virtual process. It reports one available execution
thread and does not pretend to expose physical CPU or memory statistics.
Unsupported OS metrics and Worker construction fail explicitly. Importing
worker_threads metadata is not worker-thread execution support.

The first broad run exposed a bootstrap regression in bundled execution without
the optional Web APIs. Importing fs loaded the new utilities before process was
initialized. The shared core now initializes the existing process adapter first;
the watcher regressions and a new default-runtime test passed after the fix.

## September 10: unbundled runtime modules

The full workload matrix completed 213 checks with no unexpected failures.
Each of Chromium, Firefox, and Playwright WebKit reports 18 direct guest passes,
five adapted passes, and 14 gaps. The matrix includes 30 runtime-loader checks.
The four interactive apps and four separate browser-worker runtimes pass on
each engine. These are operation-level results, not complete package support.

`WorkerKernel.runModule()` now loads CommonJS and native ESM directly from its
authoritative filesystem. Guest code is not bundled or async-transformed on this
path. The loader supports tested package exports/imports, conditions, computed
imports and requires, CommonJS cycles/cache invalidation, ESM live bindings and
top-level await, named CommonJS exports, and file URL identity. Host edits can
introduce a new module while an entry is awaiting work.

PostCSS now runs its unchanged Node entrypoint and produces source maps inside
QuickJS. Its browser entrypoint had deliberately disabled those maps. Initial,
edited, repeated, and restored outputs match the Node reference on Chromium,
Firefox, and WebKit. No package source patch or guest quota increase was needed.

Module resolution and source reading happen in the trusted worker. CommonJS
wrappers, module objects, exports, caches, and all application execution stay
inside QuickJS. `cjs-module-lexer` parses names for CommonJS-to-ESM interop in the
worker, it does not execute the package there. Builtin definitions are prepared
as a separate local artifact by `build:kernel-builtins`.

The wider loader probe also exposed a native wrapper bug: a failed ESM
normalizer returned null, which the wrapper copied into a bogus module name.
The recorded C patch propagates the failure instead. Static, dynamic, and nested
import regressions failed before the patch and pass after it, preserving the
original error and subsequent VM execution. The before/after reports include
the tested WASM hashes. This is a correctness fix, not a security audit.

The full matrix ran before that native fix. After it, all 33 affected workload
checks passed again. Verification also passed 16 unit tests, 82 development
checks plus six expected failures and two skips, 37 production checks plus two
skips, and 54 feasibility checks. The rebuilt engine matched all 34 Node ALS
cases, including concurrent branches and garbage collection.

All 16 desktop checks passed across Chromium, Firefox, WebKit, and installed
Chrome. WebKit completed three full workflow cycles and 60 seconds idle, with
1731 MiB peak renderer RSS and 1720 MiB at idle, below the 2048 MiB gate. This
does not certify installed Safari, Edge, other operating systems, phones, or
indefinite operation, and the browser-process footprint remains substantial.

[Runtime loader discovery](reports/runtime-loading-discovery.json) records the
next blockers in all 14 remaining package gaps. It uses the existing prepared
graphs, most of which were captured for browser bundling. Missing Node entrypoints
and runtime assets are preparation gaps, not proof that a package cannot run.
The next shared API blockers include `os`, `util`, `perf_hooks`, `crypto`, and
`http`; guest WASM, native processes/addons, and package installation remain
separate requirements.

The opt-in loader is not complete Node compatibility. Synchronous `require(ESM)`
fails explicitly. JSON import-attribute enforcement, `import.meta.resolve`,
symlinks, and ambiguous `.js` syntax detection remain gaps. Each source is capped
at 8 MiB, cumulative source reads at 32 MiB per execution, and each package.json
at 1 MiB. Runtime package installation and discovery of missing package assets
are separate work. Existing `run()` still uses browser bundling.

The runtime dependency audit still has low, moderate, and high findings in
other dependencies. Adding the pinned, dependency-free MIT `cjs-module-lexer`
does not constitute a dependency or security approval for this spike.

## September 10: five workload gaps closed

The preceding sweep completed 183 checks with no unexpected failures or
retries. Chromium, Firefox, and Playwright WebKit each report 17 direct guest
passes, five adapted passes, and 15 gaps. The four interactive apps and four
separate browser-worker runtimes still pass in each engine. Results are in
[workload-summary.md](reports/workload-summary.md).

The existing regression command also passed: 12 unit tests, 76 development
passes plus six expected failures and two skips, 31 production passes plus two
skips, and 54 feasibility checks. All eight worker-kernel desktop checks passed
across Chromium, Firefox, WebKit, and installed Chrome. The WebKit memory gate
completed three workflow cycles and 60 seconds idle, with roughly 1664 MiB peak
renderer RSS and 1663 MiB at idle, below the existing 2048 MiB threshold. This
remains a substantial browser-process footprint, not a guest heap measurement
or proof of phone, Safari, Edge, Windows, or Linux support.

TypeScript transpilation and deliberate-error typechecking now run inside
QuickJS. Guest bundles omit formatting whitespace, keeping package identifiers
and native async syntax. The existing 8 MiB source and 64 MiB allocation limits
were not raised. The source limit now counts UTF-8 bytes explicitly.

React's browser SSR entrypoint, AbortSignal reason propagation, and file-watch
delivery also pass. Guest-local EventTarget, abort, clone, and message-channel
implementations run inside QuickJS. Node EventEmitter comes from the existing
`events` dependency. Filesystem notifications originate at the worker's
authoritative store, so both host edits and guest writes reach watchers.

Execution now drains pending jobs and referenced timers/watchers after the
entry module completes. Timers support cancellation, intervals, ref/unref, and
refresh. Resource callbacks retain the appropriate ALS context. An added Node
comparison caught context leaking between interval ticks; interval callbacks
now restore their creation context, while refreshing a completed timer captures
the new context. Message ports use receiver creation context, and repeated
watch events retain watcher creation context even if a callback changes it.

The 42 cross-browser runtime checks include Node comparisons and separate
host-edit, recursive-watch, cancellation, quota, callback-error, and recovery
checks. Timers and watchers are each capped at 128. Watch and message queues
are capped at 256 events per resource. Workspace paths are limited to 4096
UTF-8 bytes, with at most 16384 files, including empty files. Unit tests verify
that rejected changes and restores leave the existing workspace intact.

These are not complete Node/Web API implementations. Message transfers and
full structured-clone coverage, unhandled-rejection reporting, Node event-loop
phase ordering, descriptors, symlinks, `fs.watchFile`, and `fs.promises.watch`
remain gaps. The remaining package blockers include runtime module loading,
Node HTTP/process integration, guest WebAssembly and asset loading, and the
large eager Next source graph. Trusted browser-worker adaptations do not close
those guest-runtime gaps.

## September 10: initial package and framework workload sweep

The workload suite now covers 37 guest operations, four interactive browser apps,
four browser-native WASM tools/runtimes, and two module-resolution regression
cases per browser engine. The machine-readable results and operation-by-operation
matrix are in [workload-matrix.json](reports/workload-matrix.json) and
[workload-summary.md](reports/workload-summary.md). Test-runner success counts
completed experiments, not compatible packages.

The initial run completed 141 checks with no unexpected failures. Chromium,
Firefox, and WebKit each reported the same 12 kernel passes, five adapted passes,
and 20 gaps. All 12 interactive app checks and 12 separate browser-native runtime
checks passed. Existing regression verification also passed: 10 unit tests,
76 development passes plus six expected failures and two skips, 31 production
passes plus two skips, and 54 feasibility checks. This run did not repeat the
desktop long-idle memory gate.

Each passing guest case must match a Node reference before and after an input
edit, on repeat, and after restoration. Package source stays unchanged. Browser
exports can select different implementations from Node, and explicit standalone
or edge entrypoints are marked as adaptations. The package graph is collected on
the host and compiled again in the browser. This does not establish general npm
installation, lifecycle scripts, or runtime module loading.

The tests distinguish three execution locations:

- WorkerKernel: JavaScript and guest Web APIs inside QuickJS, with the worker's
  authoritative filesystem and existing resource limits.
- Browser-native workers: esbuild WASM, Rollup's browser distribution, SQLite,
  and Pyodide. These work outside QuickJS and do not share the kernel filesystem
  or its capability policy yet. They are fixed trusted fixtures, not safe places
  to run arbitrary user plugins or Python programs.
- DOM previews: browser Vite builds React, Vue, Svelte, and Solid apps, then an
  opaque iframe mounts them. Every iteration checks a counter click, emitted CSS,
  and an SVG asset. Svelte component compilation also runs in a browser worker.
  These are mount/rebuild tests, not SSR hydration, navigation, or HMR tests.

The first sweep exposed missing package-private imports in Babel, Svelte, and
Astro. The shared compiler now resolves scoped `#imports`, conditions, wildcard
targets, and external-package targets, with explicit boundary tests. It also
honors package browser maps, including declared disabled modules. This follows
the [Node package-import model](https://nodejs.org/api/packages.html#subpath-imports)
for the tested subset; it is not a complete Node resolver. Guest errors now keep
their stack, which exposed the missing `console.assert` used by the AbortSignal
event implementation.

Blockers recorded by the initial sweep included:

- TypeScript's JS compiler bundle exceeds the current guest source-size limit.
  This is not evidence that TypeScript inherently cannot run in this architecture.
- PostCSS transforms work; its selected browser distribution disables source
  maps, so the separate source-map probe remains a gap.
- React's default browser SSR entry needs MessageChannel. Its explicit edge
  server entry is a separate successful probe.
- Astro's container reaches missing guest WebAssembly. Browser-native WASM
  runtime success is not guest WebAssembly support.
- Express, webpack, ESLint, Vitest, and full SvelteKit/Astro builds encounter
  missing Node modules, runtime loading, and native integration paths.
- The collected Next graph exceeds the 32 MiB workspace quota. It is a partial,
  eagerly collected graph, not a measurement of Next's minimum runtime footprint.
  Preparation errors and optional/native paths are retained in the raw report.
- File watching and AbortSignal reason propagation remain gaps.

SvelteKit and Astro have real successful Node reference builds, not just import
checks. Their reference dependency scopes are separated where generated server
imports need incompatible cookie APIs. Next server preparation and guest Pyodide
are explicitly marked as having no Node reference; neither is counted as a pass.

The first cross-browser harness run used port 4190, which Firefox blocks before
loading a page. The suite now uses 4199 with default browser security settings.
The interrupted run is retained as workload-port4190-diagnostic.json, not counted
as a runtime incompatibility. The production lab action was also exercised in
Chromium and downloaded all 37 results without page errors.

These tests do not certify installed Safari, Edge, Windows, Linux, phones,
long-session memory stability, or a production hostile-code boundary. The older
42-case compatibility matrix still describes the older backends, not this kernel.

## September 10: worker-owned filesystem, without Asyncify

The next spike changes ownership instead of emulating blocking RPC. `WorkerKernel`
owns the only live filesystem inside a trusted browser worker. Agent/editor calls
send async messages to that owner. Guest `readFileSync` and `writeFileSync` call
the same filesystem directly through QuickJS host functions. There is no stale
filesystem mirror, SharedArrayBuffer, Asyncify, or async-syntax transform.

The existing native ALS engine is retained. A worker caches its loaded WASM
module, while each execution gets a fresh QuickJS runtime/context. Files survive
between executions. Closing the kernel terminates the worker and discards its
volatile files. One execution is allowed at a time per kernel, with overlapping
async branches inside that execution. Timers and bounded job batches let editor
messages run between guest turns. A synchronous guest loop still blocks this
owner until interrupted, so this is not cross-thread synchronous access.

The first WebKit probe matched all 34 Node ALS cases, observed a live agent edit
through guest synchronous reads, read guest-written files back through the agent
API, and ran three sets of overlapping real Start SSR requests. Renderer RSS
peaked at 1,568 MiB and stayed at 1,567 MiB after 20 seconds idle. ALS alone was
about 208 MiB. The large remaining increase came during the browser Vite build.
This is one cold pinned build with repeated SSR, not three cold dependency builds.

Run the separate candidate gate:

```sh
npm run probe:desktop -- --kernel
```

It tests Chromium, Firefox, WebKit, and installed Chrome, then runs three complete
kernel cycles on one WebKit page and observes 60 seconds idle under a 2,048 MiB
renderer RSS budget. The fixture's browser build is cached after the first cycle.
Results go to `reports/kernel-gate.json` and `reports/memory-kernel-repeat-kernel-gate.json`.
The original Asyncify gate remains separately reproducible and is not marked fixed.

That gate passed on this Mac: eight desktop checks, three kernel cycles, 102 ALS
comparisons, and nine Start executions (27 complete HTTP 200 responses). WebKit
peaked at 1,674 MiB and measured 1,672 MiB after 60 seconds idle. The initial
Chromium run was interrupted by a 14-minute low-power sleep recorded in the
system log; the rerun passed with unchanged timeouts. This is a bounded stability
result, not proof of indefinite operation or a low-memory-device guarantee.

Final regression verification also passed: 10 unit tests, 76 development passes
plus six expected failures and two skips, 31 production passes plus two skips,
and all 54 existing feasibility tests. Four additional desktop failure-path
checks cover immediate close during initialization, guest read-only authority,
path escape rejection, snapshot copies, CPU/heap/unresolved-await limits,
concurrent-execution rejection, cancellation, and recovery. The installed Chrome
lab button and downloadable report were checked in the rendered UI.

The lab's **Test worker-owned VM** action runs the functional proof and downloads
its report. It cannot measure total browser-process memory. This backend remains
separate from `Workspace`, its preview transport, and persistence. It shares the
same limited file contract and host-side authority checks, not a full Node fs API.
It does not solve synchronous network calls, native addons, child processes,
arbitrary Vite plugins, a full Node event loop, or long-lived VM-backed previews.

This is the preferred next architecture to investigate, not a Safari/Edge or
cross-OS certification. The generated toolchain, package paths, and security
review still prevent calling this a finished standalone SDK.

## September 10: desktop stability gate

Desktop Chrome, Edge, Firefox, and Safari are the required target. Phones are a
stretch goal. **The combined Asyncify engine has not passed that desktop gate.**
Tanner's physical iPhone completed the action and then crashed the tab. That is
a failed device run, not a successful run with a cosmetic error.

The memory reproduction now isolates the problem from Vite, esbuild, package
installation, and the UI. Three fresh combined-VM workers each run 500 native
async branches, verify their results, dispose their QuickJS runtime, and terminate.
Playwright WebKit reached about 3.1 GiB after 20 seconds of idle. The full combined
workflow reached about 4.6 GiB. Forcing page garbage collection in a diagnostic
run did not release that footprint. These are macOS renderer RSS measurements,
not guest-heap measurements or an iPhone memory measurement.

A native CPU sample shows the worker's cleanup waiting in
`Wasm::Worklist::stopAllPlansForContext` while WebKit's background
`Wasm::OMGPlan` compiler runs B3 optimization and allocation. `vmmap` attributes
the large physical footprint to WebKit malloc, not reserved WASM address space.
This strongly matches the open [WebKit compilation-memory issue](https://bugs.webkit.org/show_bug.cgi?id=304810),
but does not establish that its eventual upstream fix will fix this exact binary.

Changing our Emscripten optimization profile did not produce a usable fix:
`-O2` reached about 5.0 GiB in the small reproduction, and `-O1` failed with a
call-stack overflow. Both remain diagnostic builds, neither replaces the normal
`-Oz` engine. No browser flags, forced GC, skipped stress cases, or reduced guest
semantics are used as a runtime fix.

The investigation did uncover and fix a separate teardown bug. The Asyncify
wrapper deleted its host callback registry before `QTS_FreeRuntime`, even though
runtime finalizers still use it. It now frees the runtime first, matching the
upstream synchronous wrapper. VM completion is sent only after teardown, so this
failure cannot hide behind successful guest output. The pinned build records the
new disposal patch hash. Compiler workers also stop their own esbuild service
before reporting completion. Vite no longer starts a nested compiler worker,
and the Start server's final bundle uses a bounded worker instead of keeping a
compiler service on the lab page.

`npm run probe:desktop` builds the lab, runs the desktop lifecycle tests, starts
an owned preview server, and runs the memory gates. It stops at the first failed
gate and saves `reports/desktop-gate.json`. Do not run other WebKit tests alongside
the process-level memory probe.

To run individual checks against a built, running lab:

```sh
npm run test:desktop
npm run probe:memory -- http://127.0.0.1:4187 stress desktop-gate
npm run probe:memory -- http://127.0.0.1:4187 combined desktop-workflow
```

The desktop test runs repeated I/O, Start SSR, cancellation, idle, and recovery
in Playwright Chromium, Firefox, WebKit, and the installed Chrome channel. It is
a functionality/liveness check. The separate macOS memory probe fails and closes
its browser above 2,048 MiB renderer RSS by default, retaining the failure report.
That is a regression budget, not a production memory-isolation guarantee.
`MEMORY_LIMIT_MIB=0` disables the budget only for deliberate diagnostic runs.
`CPU_SAMPLE=1` and `MEMORY_MAP=1` retain native diagnostic reports.

Actual Safari, Edge, Windows, and Linux are not certified by these local engine
tests. Safari's installed WebDriver refused a session because remote automation
is disabled in Safari Settings. No setting was changed. Edge is not installed on
this host. The worker-owned design above avoids Asyncify for local filesystem
calls. The Asyncify backend itself would still need a compiler fix or different
suspension strategy before its desktop support could be considered complete.

## September 10: combined ALS + Asyncify + real Start SSR

The combined engine passes functional checks, but fails the desktop stability gate above. Native async context, live synchronous filesystem RPC, asynchronous filesystem replies, and timer callbacks compose in one QuickJS/WASM runtime. All 34 ALS comparisons match Node in Chromium, Firefox, and Playwright WebKit. The mixed-I/O probe deliberately delivers async replies while synchronous calls can be suspended. Read-only denial, missing files, canceled timers, workspace cancellation, heap limits, interruption, and fresh execution after failure also pass.

Real TanStack Start now executes its server bundle inside this VM. Browser Vite builds the unchanged five-file fixture from 95 pinned package archives, then the browser compiler resolves its server dependencies with the `workerd` export condition. That selects React's existing edge server entry and Router's server entry. It does not run Cloudflare workerd. Three overlapping requests return HTTP 200 and complete HTML for the homepage and `/about`. The homepage's real server-function loader reads request context after native await. This proves SSR execution, not client hydration or an interactive VM-backed preview yet.

The wrapper needed a real async job-drain method. Upstream's synchronous drain cannot suspend when an async continuation calls `readFileSync`. The new method awaits the MaybeAsync entry point and refreshes its memory view after suspension. One worker loop owns all WASM entry; host messages and timers queue guest-promise settlements while a WASM stack is suspended. Build probes caught two integration errors: assertions-enabled Asyncify needs the matching upstream debug FFI, and that TypeScript source requires assignment-style class-field initialization. Both are fixed in the build, not bypassed in guest code.

Guest Web APIs use pinned open-source implementations of URL, encoding, streams, Request, Response, Headers, Blob, File, FormData, and AbortController. Streaming UTF-8, request cloning, body consumption, and header access have targeted passing checks. They are not a full Web Platform Tests pass. The data-type bundle has no fetch transport or guest CSPRNG. Multipart creation that needs secure randomness remains unsupported. The old UTF-8-only decoder was replaced with one that supports streaming. Crypto signing implementations are not pulled into this guest bundle.

The combined WASM is 1,049,685 bytes with assertions enabled. A second build reproduced its SHA-256. The unminified guest Web API bundle is 1,757,759 bytes. Source patches, build hashes, package versions, and third-party notices are retained. These are experimental artifacts, not an audited distributable runtime. npm audit still reports advisories in existing toolchain/browserify dependencies; no automatic dependency upgrades were applied.

Full `npm run check` passed: 9 unit tests; 76 development browser passes with 6 expected failures and 2 skips; 31 production passes with 2 skips; and 54 feasibility checks with no unexpected failures. The combined work contributes 18 browser checks across three engines. Existing backend compatibility gaps remain recorded, not erased by the opt-in engine. Evidence is in [the combined test report](reports/combined-engine.json) and [the final full feasibility run](reports/feasibility-results.json).

Run `npm run probe:combined`, or use **Test combined VM + Start** in the lab. It runs the 34 comparisons, mixed I/O, and real Start SSR and offers one JSON report. Desktop narrow-viewport tests are not physical-device evidence. Tanner reported **34/34 matched on his iPhone for the earlier non-Asyncify ALS engine**. The later combined run crashed the phone tab after completing, as recorded above.

The refreshed public HTTPS lab also passed the complete combined action in narrow desktop WebKit: 34/34 ALS matches, mixed I/O passed, and all three Start responses returned 200 with complete HTML. Cross-origin isolation was false and the host SharedArrayBuffer API was unavailable. The downloaded device-shaped report is [retained here](reports/combined-public-webkit.json). This verifies the reachable phone build, not physical iPhone execution.

The next useful gate is a persistent VM request loop connected to the existing preview transport, with end-to-end streaming, cancellation, hydration, and POST server-function checks. Vite and its plugins still execute in the trusted browser toolchain, not inside QuickJS. General package execution, runtime module loading, Node event-loop semantics, a full filesystem contract, native addons, and security hardening remain separate work. The worker still ends when its entry module completes, and unhandled rejection reporting is not a complete Node process model.

## September 10: native ALS inside QuickJS

Feasible without lowering async syntax. A custom QuickJS/WASM engine with context capture on promise reactions and queued jobs matches Node v24.15.0 on all 34 targeted ALS cases. The same JS adapter on unpatched QuickJS matches 6/34, so the result depends on engine propagation, not on a global-value shim or serialized execution.

The final corpus passed inside production browser workers in Chromium, Firefox, and WebKit, without cross-origin isolation. It covers native await, overlapping and nested contexts, foreign resolvers, shared promises, exceptions, bind/snapshot, multiple storages, thenables, async generators, eval and AsyncFunction, 500 parallel branches, and unreachable context/promise cycles under allocation pressure. Separate checks passed for host filesystem RPC, queueMicrotask, bound timers, timer cancellation, heap limits, interruption, and recovery. The full 34-case phone action also passed through a fresh public HTTPS tunnel in desktop WebKit. Tanner subsequently reported 34/34 matched on his physical iPhone. This is one device report, not a general iOS certification.

`npm run check` passed: 9 unit tests; 76 development browser passes plus 6 expected failures and 2 skips; 31 production passes plus 2 skips; and 36 feasibility checks. Existing compatibility gaps remain recorded separately. The new engine is opt-in with `executeInVM(entry, { engine: 'quickjs-als' })`; the native-worker, stock QuickJS, and Asyncify backends have not been silently replaced.

The patched engine is 510,605 bytes of WASM with assertions enabled. Rebuilding with the recorded SDK and patch produced the same WASM SHA-256. The patch includes reference cleanup and GC marking, but is not a security audit or a complete implementation of Node async_hooks. It does not yet include AsyncResource, cross-realm propagation, or a full Node event loop. The subsequent combined-engine spike is described above.

Reproduce with `npm run probe:engine-als`. See [build instructions and boundaries](patches/README.md), [the engine patch](patches/quickjs-async-context.patch), [Node and stock-engine controls](reports/engine-als.json), and [final browser evidence](reports/feasibility-results.json). The lab's **Test native QuickJS ALS** action runs the corpus on the current device and downloads a JSON report.

## September 10: Node feasibility and synchronous I/O

The iPhone device test reported by Tanner passed the scripted workflow, QuickJS workflow and limits, and the Start build, counter, POST server function, and navigation. This is one real device/browser combination, not a blanket iOS compatibility claim. Suspension, private browsing, eviction, and low-memory behavior remain unverified on hardware.

Verification after this work: 9 unit tests; 76 development browser cases plus 6 expected failures and 2 skips; 31 production cases plus 2 skips; and 24 feasibility regression checks with no unexpected failures. The feasibility checks include assertions about known limitations, not 24 new compatibility promises. After correcting the phone probe's mistaken assumption about QuickJS's own SharedArrayBuffer constructor, the rebuilt feasibility suite passed again. Narrow desktop WebKit completed the lab's 84 comparisons and downloaded its JSON report. The new synchronous-I/O probe also passed through the existing public HTTPS tunnel in WebKit, with the host SharedArrayBuffer unavailable and cross-origin isolation false. The new probe has not yet been confirmed on the physical phone.

`npm run probe` now builds the lab and runs a production-only feasibility suite in Chromium, Firefox, and Playwright WebKit. `npm run check` includes it after the existing regression suites. `npm run probe:reference` executes the checked-in trusted corpus on the installed Node binary, records its exact version, and hashes the corpus. The browser refuses a missing or stale reference. No user-submitted guest program is executed by the Node reference runner.

The 42 differential cases cover ESM and CommonJS, computed imports, package exports, filesystem semantics, path operations, timer/process lifetime, async context, buffers, events, crypto, streams, URLs, and HTTP/subprocess/worker API presence. Each case runs in a new workspace on both existing backends. The HTTP/subprocess/worker surface probes test imports and exported functions, not working sockets or subprocesses.

All three engines initially agree: 19/42 cases match Node v24.15.0 on the native backend, 14/42 on the ordinary QuickJS backend. Those are selected probe counts, not a percentage of Node compatibility. The native backend has 23 recorded gaps and QuickJS 28. Gaps are not counted as semantic passes. See [the generated matrix](reports/compatibility-summary.md), [raw per-case results](reports/compatibility-matrix.json), and [browser assertions and diagnostic attachments](reports/feasibility-results.json). Matching compares exit code and stdout, not full filesystem side effects or all API contracts.

### Synchronous I/O does not require SharedArrayBuffer

The new experimental `executeInVM(entry, { engine: 'asyncify' })` path uses the pinned `@jitl/quickjs-wasmfile-release-asyncify@0.32.0`. Guest `readFileSync`, `writeFileSync`, `statSync`, and `readdirSync` suspend the interpreter while an asynchronous message asks the existing host filesystem broker for the result. The host stays responsive and retains write permission, path checks, and byte quotas. There is no mirrored filesystem that silently becomes stale.

Chromium, Firefox, and WebKit pass live host mutation visibility, binary reads/writes, 100 sequential brokered reads, read-only denial, path escape rejection, interruption after I/O, allocator failure, and workspace cancellation during a synchronous call. This does not use cross-origin isolation or SharedArrayBuffer. The Asyncify WASM asset is about 1.03 MB raw, versus 503 KB for the ordinary QuickJS variant. Execution timings in the attachments are local desktop measurements, not phone benchmarks.

This is an architectural proof, not a complete third Node runtime. It deliberately rejects pending module promises/jobs: an event-loop scheduler that safely handles suspended interpreter stacks has not been implemented. It has no general runtime module loader, timers, Fetch, Node buffers, callbacks, descriptors, symlinks, native addons, or subprocesses. The separate Node matrix still measures the original native and ordinary QuickJS backends, not this experiment.

Asyncify transforms WASM execution so synchronous guest code can await host operations, with code-size and runtime costs. Re-entering an already suspended interpreter is not safe. The worker only resolves host JavaScript promises in message handlers and does not enter QuickJS again until evaluation resumes. See the [QuickJS Asyncify interface](https://github.com/justjake/quickjs-emscripten#asyncify) and [Emscripten's Asyncify and reentrancy documentation](https://emscripten.org/docs/porting/asyncify.html).

### Bugs fixed and failures retained

The differential probes found that the handwritten path shim lost leading `..`, mishandled a later absolute argument to `resolve`, and changed trailing separators and parse results. It now uses the already-installed MIT-licensed `path-browserify` implementation with workspace-root cwd. The compiler also now gives CommonJS `require('node:path')` the actual default builtin object, not an ESM namespace wrapper. Upstream identity assertions caught that second bug.

Nine unmodified upstream test bodies from pinned `path-browserify@1.0.1` now exercise our builtin through a small strict synchronous tape-method adapter. They run 263 assertions per backend/browser, with 11 explicitly skipped Windows groups. The source hashes and license are retained in `public/feasibility/path-upstream.json`. The adapter supplies virtual filenames and process cwd, and the reference excludes Win32 consistently. This is a POSIX subset of a Node-derived upstream suite, not the full modern Node test suite or the full tape runner. Newer Node path behavior outside this subset is not established.

The scale probe separates module count from syntax depth. All three browsers build and execute flat 100-, 500-, and 1,000-module graphs. A left-associated 1,000-term addition expression hits a WASM call-stack overflow in WebKit, while Chromium and Firefox complete it. The suite retains that failed shape as a recorded limit, not a repaired result. The exact failing WASM component and a production fix still need investigation. Fresh builds recover after both this failure and deliberately invalid source. These small synthetic modules do not establish large real-world application capacity or mobile memory ceilings.

The HTTP probes confirm three more gaps: response bodies are buffered until the stream ends, a pre-aborted Request is still handled, and a slow request delays later requests because the native guest serializes handlers. Those behaviors are pinned as observed limitations, not HTTP compatibility passes. Fixing concurrency depends on fixing async context, not removing serialization and hoping request state stays isolated.

Repeated-execution probes run 12 edit/read/write cycles per backend, hit the output quota, verify a subsequent execution still works, then save and restore files after a full page reload. These are targeted containment and recovery checks, not a security audit or a total browser-process memory guarantee.

A full regression run also encountered `ERR_NETWORK_CHANGED` and failed registry downloads. The fixture build now copies its 95 exact public archives from the standard npm v2 content-addressed cache, verifies every SHA-512 digest and size, and serves them as static fixture assets. That adds about 10.9 MB of compressed archives. The browser installer still verifies every archive before extraction. The original registry lock is retained beside the local fixture lock. The SSR regression explicitly blocks the registry to verify it no longer depends on live npm downloads. This is a self-contained fixed fixture, not a general offline package manager. Building it requires the pinned archives in npm's configured cache, with a specific cache-population command reported if one is absent.

Compiler bootstrap also now has an explicit ready handshake. Downloading/initializing the 14 MB compiler WASM has a separate 120-second startup deadline; actual compilation retains its 30-second limit. A slow asset load no longer consumes the compilation budget or reports itself as guest compilation work. This does not make an unavailable network work, and workspace cancellation still terminates the worker during either phase.

### Current decision

Continue the browser-container work, but do not call the current runtime Node-compatible. The native route proves useful browser builds and Start previews. Asyncify removes an important synchronous-I/O obstacle while preserving broad-browser prerequisites. Neither route yet proves a general package/runtime contract.

The next architectural gates are a VM job/process scheduler that handles async work and suspended calls, correct concurrent async context, runtime CommonJS/ESM loading, and a fuller filesystem/Buffer contract. A general Vite plugin or config must not run inside the current trusted same-origin toolchain worker. Preview origin allocation, malicious resource floods, streaming/cancellation, package resolution/cache, and native dependency strategy remain independent release blockers.

For a phone, the lab's **Run feasibility suite** button runs the new synchronous-I/O proof and all 84 backend comparisons and offers one JSON download. It does not require a model API key or send the report anywhere. The original Start controls remain available. Lock/resume and browser eviction need separate device tests; desktop automation is not substituted for those results.

## Previous spike baseline

September 9, 2026. This is an experimental source SDK and an executable set of probes, not a hardened sandbox release.

The follow-up adds real preview URLs and a QuickJS workspace backend. Start now hydrates, navigates, reloads deep links, and calls a POST server function in Chromium, Firefox, and Playwright WebKit. QuickJS runs the file-backed edit/test loop in all three engines.

Full `npm run check`: 9 unit tests passed, TypeScript and production build passed, 76 development browser cases passed with 6 expected failures and 2 skips, and 31 production cases passed with 2 skips. No unexpected failures. The expected failures are the old srcdoc hydration negative control and nested ALS, each in all three engines. The worker-stop probe is Chromium-only, so Firefox and WebKit each have one explicit skip in both suites. The runner counts expected failures in its green total of 82, inspect the JSON annotations for the breakdown.

## Run it

```sh
npm install
npm run dev -- --host 127.0.0.1 --port 4173
# In a second terminal, for the real-URL Start preview:
npm run dev:preview
```

Open `/sandbox.html` for the new lab. `/` keeps the original runtime demo.

The preview bootstrap listens on loopback ports 4174 and 4175. The lab uses 4174 and tests use both. Do not open these as standalone app servers: app responses come from the owning browser workspace. Do not use your phone's `localhost` or an insecure LAN URL for this layer. A device test needs reachable HTTPS origins for both the host and the preview, with matching SDK configuration.

For same-Wi-Fi device testing, run `npm run dev:lan -- <Mac-LAN-IPv4>`. This leaves the localhost servers alone, starts a phone setup page on HTTP port 4442, the HTTPS lab on 4443, and HTTPS preview origins on 4444 and 4445. It binds only to the selected private network interface, with no public tunnel. The lab uses `VITE_SANDBOX_PREVIEW_ORIGIN` to reach the phone-accessible preview instead of the phone's localhost.

The LAN launcher requires OpenSSL 3, creates a seven-day test CA and server certificate in an owner-only temporary directory outside the workspace, and serves only the public CA certificate from the setup page. It does not install trust on the Mac or phone. On the phone, manually install the named certificate profile and enable its SSL trust, following the setup page and [Apple's instructions](https://support.apple.com/en-us/102390). A trusted CA can authorize certificates signed with its key, so remove this test profile when finished. Each launcher invocation creates a new CA, so old phone profiles need removal when restarting. Stop the launcher with Ctrl+C to stop its LAN servers. The temporary key files are not automatically deleted. This is local development hosting, not production certificate or origin management.

```sh
npm test
npm run build
npx playwright test --workers=3
npx playwright test --config=playwright.production.config.ts --workers=3
```

Install missing test browsers with `npx playwright install chromium firefox webkit`. Browser results and diagnostic attachments are written to `reports/browser-results.json` and `reports/production-results.json`. Known semantic failures are marked as expected failures only after their setup succeeds. The runner can count them as passing tests, so inspect the annotations, not just its green total.

## What works

The scripted agent workflow creates a workspace with an intentionally broken TypeScript function, runs a failing test, applies an exact patch, reruns the test, starts a request handler, bundles a client, clicks its preview, observes a server-side file write, saves a checkpoint, and reruns the test from a restored workspace. It makes no model calls and does not pretend to perform autonomous reasoning.

The source API is in `src/sandbox/index.ts`:

```ts
import { Workspace, Preview } from './src/sandbox'

const workspace = new Workspace({ files: {
  '/main.ts': `import { writeFile } from 'node:fs/promises'
    await writeFile('/answer.txt', '42')
    console.log('done')`,
} })

const result = await workspace.execute('/main.ts')
// Same files, explicit capabilities, QuickJS allocator and execution limits:
const controlled = await workspace.executeInVM('/main.ts', {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 5000,
})
await workspace.save('my-checkpoint')
workspace.close()

const restored = await Workspace.open('my-checkpoint')
console.log(await restored.files.readText('/answer.txt'))
restored.close()
```

`execute` evaluates a bundled module through top-level await and then terminates its worker. It is not a Node CLI process, shell, or implementation of Node's event-loop exit rules. `serve` keeps a fetch-handler process alive. Call `close` when done. Request bodies and responses are currently buffered, with a 16 MiB transport check, not a streaming/backpressure implementation.

| Probe | Chromium | Firefox | Playwright WebKit |
| --- | --- | --- | --- |
| Scripted edit, test, preview, checkpoint loop | Pass | Pass | Pass |
| Independent concurrent workspaces and binary files | Pass | Pass | Pass |
| Checkpoint recovery after page reload | Pass | Pass | Pass |
| Native-worker runaway termination and read-only files | Pass | Pass | Pass |
| Pinned npm download, CommonJS execution, bad-integrity rollback | Pass | Pass | Pass |
| Concurrent Vite builds without changing host globals | Pass | Pass | Pass |
| Real Start build and SSR in an opaque guest | Pass | Pass | Pass |
| Real-URL Start hydration, navigation, reload, POST server function | Pass | Pass | Pass |
| Separate preview origins and ownerless/ambiguous-owner denial | Pass | Pass | Pass |
| Preview service-worker stop and restart | Pass | Not tested | Not tested |
| Full Start hydration in the srcdoc preview | Fails | Fails | Fails |
| Concurrent nested AsyncLocalStorage stores | Fails | Fails | Fails |
| QuickJS interruption and allocator-limit probes | Pass | Pass | Pass |
| QuickJS edit/test loop, async filesystem, binary checkpoint | Pass | Pass | Pass |
| QuickJS read-only paths, concurrent workspaces, cancellation | Pass | Pass | Pass |
| QuickJS bounded CPU, heap, pending await, async CPU loop | Pass | Pass | Pass |
| Opaque worker under complete COOP/COEP hosting | Pass | Pass | Fails |

These are desktop automation results. Playwright WebKit is not proof of real iOS Safari support. Device memory, backgrounding, private browsing, storage eviction, embedding restrictions, and mobile networking still need hardware testing.

Adding Firefox also exposed a problem in the original static SSR viewer: its existing iframe remained at about:blank after receiving the response. The same response rendered in a freshly mounted sandbox frame. Removing preload links alone from the original viewer did not resolve it, so preload handling cannot be claimed as the root cause. The viewer now mounts each static response as a fresh sandbox document and strips scripts and unmapped preload links. This remains an SSR-only viewer, not a hydration fallback.

## Findings that change the design

### Full previews need real URLs

The Start server renders successfully, and its generated client bundles successfully. Hydration fails when browser history tries to change `about:srcdoc` into an application URL from an opaque origin. Chromium reports a `history.replaceState` security error, WebKit reports a blocked history change, and Firefox reports an insecure operation. The rendered preview falls back to Not Found.

`URLPreview` now supplies a real, separate origin. Its service worker routes navigation, raw Vite client chunks, and server-function requests through a static bridge back to the owning workspace. Start runs its generated client module graph without rebundling it or replacing fetch/history. The counter, second route, back/forward history, deep-link reload, and POST server call pass in all three engines. The old srcdoc failure stays in the suite as a negative control.

The Node script in `scripts/serve-preview-host.mjs` only serves four static bootstrap files and a health response. It does not receive project files, run Vite, run Start, or answer application routes. Application requests stay in the browser. A real deployment still needs HTTPS hosting for these static assets and an exclusive origin per workspace. Same-origin subpaths are not workspace isolation.

An important failure was Start returning 403 for server functions. Fetch metadata normally appears at the browser network layer, after service-worker interception. Browser `Request` constructors also filter headers that a server-side Request must preserve. The service worker now derives caller origin from its browser-owned client record and denies unverified non-navigation requests. `IncomingRequest` retains the incoming header collection while using native request-body behavior. Start's default CSRF check remains enabled, and a request without verified origin information still returns 403. Header preservation and clone behavior are exercised by the POST fixture.

The worker discovers its bridge client on every request. A forced worker stop in Chromium recovers without reopening the workspace. Zero or multiple bridge clients fail closed instead of selecting a workspace arbitrarily. Restart was not tested in the other engines because the test uses Chromium's worker-stop protocol. WebKit's embedded service worker is partitioned from a new top-level preview tab in this test: the tab gets the static 503 response, while an orphaned iframe under the original host gets the worker's 503. Pop-out previews need their own tested attachment flow.

The current origin lease is only a source-level spike. There is no public origin allocator, authenticated ownership handshake across deployments, safe origin-reuse protocol, or stale-tab/storage cleanup. User previews can access their own origin's storage. These ports must never be reused for sensitive applications or treated as production multi-tenant isolation. Service-worker secure-context and lifecycle requirements are described in the [MDN Service Worker API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

Transport is buffered, not streaming. HTTP cookie/session behavior, redirects, downloads, websockets, general asset types, and hostile protocol/resource flooding need separate compatibility tests. The preview's CSP restricts scripts, workers, frames and fetch destinations, but a DOM preview can still navigate itself. No zero-egress or main-thread CPU limit is claimed.

Do not fix this by overriding history or changing Start to use a fake location. That would hide the compatibility failure.

### A DOM preview has a different security boundary

The worker runs inside an opaque-origin iframe. Its CSP blocks external fetch, WebSocket traffic, external module imports, and JavaScript string evaluation. WebAssembly compilation is allowed. Storage access fails and there is no DOM. Files are accessed through a broker that enforces workspace ownership, write permission, and the filesystem byte limit. Chromium emits a request event for a denied dynamic import, followed by a CSP failure, not a completed network response.

The preview also cannot read its parent page, but a script can navigate its own iframe to an external URL with data in the query string. An executable test sends only synthetic data to the local probe server and confirms this. A preview must not be described as having enforced zero network egress. The network restriction in the worker does not make a full DOM preview safe for secrets.

These tests are targeted probes, not a security audit. Native guest workers can allocate memory, spawn blob workers, or flood messages. Filesystem/output checks and host-side timeouts do not impose a hard browser-process memory ceiling. The preview's main thread can also hang, unlike the killable worker-backed process.

### Native JavaScript and an embedded engine serve different needs

The native worker path already runs useful TypeScript and the real Start SSR output. It benefits from the browser engine and its web APIs. Our Node shims remain partial. The explicit ALS test shows that overlapping nested stores do not behave like Node. Serializing requests does not solve nested concurrency inside a request.

The separate QuickJS/WASM probe exposes no fetch, storage, DOM, Worker, or process APIs to guest code. It can interrupt an infinite loop and reject a single string allocation beyond a configured QuickJS allocator limit. All three engines pass these checks. This is a candidate for executing less-trusted agent tools with deliberately granted host functions.

The configured 1 MiB guest allocation limit is not a 1 MiB sandbox: the measured WASM linear memory starts at 16 MiB, before host overhead. It is not a total process-memory guarantee. One earlier allocation-loop probe hit its CPU deadline before the allocation check in Firefox, so the suite separately checks a bounded allocation and CPU interruption. It does not imply every allocation pattern is covered.

`Workspace.executeInVM` now bundles the same workspace source and evaluates it in QuickJS. Explicit asynchronous host functions expose the shared filesystem, UTF-8 and binary file reads/writes, basic directory listing and stat, console output, and supplied process env/argv. Both backends use the same host path checks and write authority. The VM cannot grant itself write access by modifying its shim. A bounded job pump waits for host RPC and propagates top-level-await failures. Workspace closure terminates the worker. Tests cover an unresolved await and an infinite loop after an await, not only synchronous code.

The installed `is-number@7.0.0` CommonJS package now runs in both backends. That demonstrates a small package through the existing bundler, not general npm or runtime module-loader compatibility. QuickJS still has no timers, Fetch/Request/Response, Node event-loop exit behavior, synchronous filesystem, subprocesses, or Start support. Unawaited background tasks are not process lifetime. Files survive checkpoints, QuickJS heaps and pending jobs do not. The compile worker is trusted and separate from the VM, so the QuickJS allocator limit does not bound compilation memory. The host has an additional worker timeout with engine-startup allowance.

The synchronous-module test caught a handle-ownership bug during development: inspecting a non-promise returns the original QuickJS handle, not a second disposable handle. The scheduler now checks `notAPromise` and disposes it once. Both synchronous and async cases pass. See the upstream [runtime controls](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md) and the pinned package's type documentation for the memory and pending-job APIs.

### Hosting policy affects browser support

The original demo unnecessarily enabled cross-origin isolation everywhere. The baseline now does not require SharedArrayBuffer, COOP, or COEP. An explicit test applies the isolation headers to the entire host, including worker assets. The chosen classic-worker bootstrap works there in Chromium and Firefox, but WebKit blocks the opaque blob worker. Module-worker boot also failed in Chromium in the initial probe.

`SANDBOX_CROSS_ORIGIN_ISOLATED=1 npm run dev` reproduces isolated hosting. Do not claim this SDK embeds unchanged on every site's existing security-header configuration.

### Builds now have independent state

Previously, Vite installed globals into the host page and reused one memfs volume. Each build now starts its own trusted toolchain worker, waits for an explicit ready handshake, and terminates after returning outputs. Two concurrent Vite projects produce distinct outputs without adding Buffer, process, or the engine to the host window.

This remains a pinned, prebundled Vite/Start toolchain with controlled configuration. Running arbitrary Vite configs, plugins, lifecycle scripts, or native addons is not covered. The toolchain worker is same-origin and must not be treated as the hostile-code boundary. Module hooks in future toolchains need their own containment design.

The engine asset is about 12.4 MB uncompressed and esbuild WASM about 14 MB. Start downloads 95 locked packages. Cold-start transfer, extraction memory, shared immutable package storage, and caching matter substantially on mobile. No offline package-store claim is made.

## Scope of the filesystem and installer

Files preserve bytes. Reads, writes, and snapshots copy buffers. Paths escaping the workspace root are rejected. File/directory conflicts, exact-patch conflicts, byte quotas, and stale snapshot commits have unit tests. Directories are inferred from files, so empty directories, symlinks, permissions, timestamps, and filesystem watches are not implemented.

Checkpoints use one atomic IndexedDB record. A failed save surfaces an error. There is no silent persistence fallback. Checkpoints contain files, not running JavaScript heaps, pending jobs, sockets, or agent model state. Multiple tabs can overwrite the same checkpoint key, there is no cross-tab compare-and-swap or coordination yet.

The installer accepts the existing explicit runtime lock format, restricts SDK downloads to the npm registry, omits credentials, rejects redirects, verifies SHA-512, and stages changes before committing against the workspace revision. Archive downloads and decompressed data are bounded. Workspace closure cancels ongoing fetches. General npm semver resolution, arbitrary lockfiles, lifecycle scripts, native addons, and complete tar-format handling remain out of scope.

## Release blockers

- Production preview hosting, authenticated origin allocation/ownership, origin reuse, and lifecycle recovery beyond the local probes.
- A reviewed threat model, broker protocol validation, and hostile-code resource tests beyond these targeted probes.
- A deliberate runtime strategy for Node semantics, especially synchronous I/O, async context, and process lifecycle.
- Real iPhone/Safari and low-memory device tests, including suspension and recovery.
- Package cache, dependency resolution, and toolchain compatibility beyond the pinned fixture.
- Packaging and license review. The root package remains private, and public toolchain asset paths still assume the host serves `/vite-runtime/` and `/start-fixture/`.
- Dependency audit remediation. The inspected tree reported 8 findings: 1 high (`js-yaml`), 3 moderate, and 4 low. The others include the Vitest mocker, `qs`, and the `elliptic` chain under crypto-browserify. No blanket force-upgrade was applied during the spike.

## Next experiments

1. Integrate the worker-owned kernel with workspace persistence and the preview request loop, retain the memory gate, then verify actual Safari, Edge, and other desktop operating systems. The Asyncify backend remains a failed comparison. Phone memory, suspension, and eviction remain stretch-goal tests.
2. Design origin ownership and reuse as a security boundary, then attack it with adversarial frames, old tabs, worker replacement, forged broker messages, and message floods.
3. Decide which Node semantics are product requirements. Run a pinned upstream conformance subset for async context, filesystem, module resolution, and process lifetime, with explicit unsupported results.
4. Test a capability-based networking API and streaming transport separately from DOM navigation. Do not let a fetch allowlist imply that browser previews have zero egress.

The shared workspace API is viable enough to continue. Full browser-computer compatibility and a production hostile-code boundary are still engineering work, not demonstrated properties of this spike.
