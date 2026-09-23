# QuickJS native async context spike

The patch targets quickjs-emscripten v0.32.0, commit
`df4efb9ef2cb25c417ecb57986da462d11b244ed`, whose vendored Bellard QuickJS
reports version 2025-09-13. It does not patch browser promises or lower async
syntax. The source and generated engine retain their upstream MIT licenses.

## Build

Install Emscripten 5.0.1 in a task-local directory. Do not change shell startup
files or install a global SDK. For example:

```sh
mkdir -p .toolchains
git clone --depth 1 --branch v0.32.0 https://github.com/justjake/quickjs-emscripten.git .toolchains/quickjs-emscripten
git clone https://github.com/emscripten-core/emsdk.git .toolchains/emsdk
git -C .toolchains/emsdk checkout --detach 5eb0bde7585670252e8ba05e9d361627bffd08b5
.toolchains/emsdk/emsdk install 5.0.1
.toolchains/emsdk/emsdk activate 5.0.1
npm ci
npm run build:engine-als
npm run probe:engine-als
```

These commands assume a fresh checkout. Keep an existing toolchain directory
if it matches the pinned revision, otherwise use a new directory and pass its
path explicitly. For guest WASM engines, also acquire the pinned interpreter:

```sh
git clone https://github.com/wasm3/wasm3.git .toolchains/wasm3
git -C .toolchains/wasm3 checkout --detach 5fe766c933c7595d728d6172bb1a197607d85b4e
```

The fixture preparation scripts run the pinned `wat2wasm` and `wast2json`
binaries with Node's WASI support. They do not need a previous native interpreter
probe or its temporary build directory. They use `.toolchains/wasm3` by default;
set `WASM3_SOURCE_ROOT` to select another checkout. Assembler hashes are checked.
The interpreter and HTTP/2/TLS probe build scripts use
`.toolchains/emsdk/upstream/emscripten/emcc` by default, or the explicit `EMCC`
path. Their compiler-version checks still apply. Optional probes are not extra
SDK release gates.

This builds the base ALS engine only. It does not build every engine and asset
required by the SDK alpha. The full fresh-source SDK build remains a release
gate in `ALPHA.md`.

The build script
accepts source-directory and emcc-path arguments, verifies the source revision
and SDK version, applies the recorded patch to a clean source file, and rejects
unrecognized source changes. No guest project or package scripts run on the host.

`public/quickjs-als/build.json` records source, patch, WASM hashes, and binary size.
Assertions are enabled. The normal build remains
available and is the default. Generated JS glue and WASM are a matched pair,
replacing just the WASM beneath the stock glue is not supported.

## What changed

`quickjs-engine.patch` is the current complete patch, containing native async
context propagation, guest script compilation, cross-realm script deadlines,
a per-context string-code-generation policy, the live-global bridge, native
child-context creation, job draining, and allocator cleanup/accounting fixes.
The default sync and Asyncify artifacts contain this patch. The older
`quickjs-async-context.patch` is retained as the historical ALS-only patch.
The build checks the complete patch rather than applying both.

- `JSContext` holds the active context value, with initialization, marking, and cleanup.
- `JSPromiseReactionData` captures that value in `perform_promise_then`, including native await.
- Reaction jobs restore the captured registration context, not the resolver's context.
- Other queued jobs capture their scheduling context, covering thenable assimilation.
- Execution restores the prior value even after an exception. Pending jobs and reactions release their retained values.
- Two bootstrap-only C functions expose context get/set. The bootstrap captures and removes them before guest code runs.

The worker kernel also captures and removes `__qjsCompileScript`. Compiled
QuickJS bytecode is owned by a guest function and released through normal GC.
Script execution returns the actual guest value, including promise identity,
without a host eval or async transform. Local script deadlines can be caught,
but cannot override the outer worker execution deadline or heap limit.
The deadline stack belongs to the runtime, so calling into another context
does not escape the active script budget.
When several budgets expire between polls, execution unwinds to the outermost
expired owner. An inner timeout catch cannot hide its parent's expired budget.

`__qjsDisableStringCodeGeneration` is a one-way bootstrap capability. It blocks
guest eval and all Function constructor types with that realm's EvalError,
while host script/module compilation remains available. The ALS bootstrap
removes it before guest execution. It is not a WASM policy or a security boundary
between realms that intentionally share functions.

`npm run probe:context-primitives` compares the policy and nested cross-context
deadlines with Node. The workload suite repeats the shared engine corpus inside
browser workers. Public VM contexts have their own Node comparison corpus.

The engine provides `__qjsContextifyGlobal`.
This bootstrap-only hook installs a QuickJS exotic global with live access to
the supplied guest object and separate backing declarations. It does not copy
properties into a second sandbox or use a host JavaScript Proxy. Lexical bindings
stay in the realm's lexical environment. Global reads, writes, declarations,
descriptors, enumeration, and prototype operations go through the bridge.
The ALS bootstrap removes the hook before ordinary kernel guest execution.

Compiled-script runners now execute in the retained bytecode's realm, not the
calling context supplied to CFunctionData callbacks. The bridge corpus caught
this distinction with a parent calling a child's compiled script.

Build a separate candidate with `node scripts/build-quickjs-als.mjs --opt=Oz`, then
run `npm run probe:context-globals`. The browser test records its own candidate
hash separately from the kernel hash. It repeats 42 Node comparison scenarios
and the 39 primitive checks three times per engine.

`__qjsCreateContext` now creates GC-owned guest contexts for public `node:vm`,
captures their compiler, and removes private capabilities before returning.
The runtime limits creation to 64 attempts per execution. A native job pump
keeps the host wrapper from adopting borrowed, GC-owned child-context pointers.
Child-generated imports cannot invoke the workspace module loader, which is
deliberately stricter than Node. `npm run probe:vm-contexts` separates that
policy check from its 46 Node comparisons. Proxy-sandbox conformance remains open.

The Emscripten allocator now reports `malloc_usable_size` instead of zero.
Previously, retained allocations and reallocations could exceed the configured
aggregate guest limit. Allocation-pressure tests also exposed two cleanup bugs:
failed raw contexts remained on the GC list, and failed Proxy initialization
could free a consumed constructor twice. Both paths are corrected.
Run `node scripts/probe-allocator-accounting.mjs`,
`node scripts/probe-context-allocation.mjs`, and
`node scripts/probe-context-allocation-asan.mjs` for the retained-allocation
controls and 1,025-point context-creation sweeps. Browser tests repeat these
against the default engine. These are not exhaustive allocation-failure tests
or a limit on total browser/WASM memory.

`npm run probe:guest-scripts` compares the same-realm operations with Node.
The browser workload suite adds ALS, authority, and recovery checks. Compiled
caches, VM modules, compileFunction, custom dynamic-import callbacks, and
after-evaluate microtask draining remain unsupported. This is not full node:vm
compatibility.

`quickjs-module-normalizer-error.patch` fixes the wrapper's null return handling
when a host module normalizer raises an exception. Without the check, the wrapper
copies address zero as a module name and replaces the original error with a bogus
load. `node scripts/probe-module-normalizer.mjs` checks static, dynamic, and nested
imports plus recovery. The before/after reports record the tested WASM hashes.
The build applies this patch to both synchronous and Asyncify variants and
records its hash separately.

The JS adapter in `src/sandbox/engine-als-bootstrap.js` provides the Node-shaped
ALS API using context maps. Its tested behavior targets Node v24.15.0, including
that version's frame-local `disable()` behavior. This is not a claim that all
Node releases or all ALS edge cases behave identically.

The runtime exposes this opt-in backend through:

```ts
await workspace.executeInVM('/main.mjs', { engine: 'quickjs-als' })
```

Host filesystem promises resume through engine reactions. The experimental
`setTimeout` adapter captures callbacks with ALS.bind, caps pending timers,
supports clearTimeout, and releases handles during cleanup. It is not a full
Node timer/event-loop implementation. The worker still finishes when module
evaluation finishes, not when every outstanding callback finishes.

## Evidence and limits

`npm run probe:engine-als` runs the same trusted cases on Node, stock QuickJS
with a context-map adapter but no engine propagation, and patched QuickJS.
It then runs the production browser tests. `npm run check` includes these
browser tests in the larger feasibility suite.

The corpus checks immediate restoration, nested and parallel work, external
resolvers, shared promises, exceptions, bind/snapshot, independent storages,
thenables, native async generators, eval, AsyncFunction, 500 concurrent branches,
and garbage collection of unreachable context/promise cycles while a live
context remains. One probe counts Promise.prototype.then calls specifically
inside native await, after module startup bookkeeping has completed.

This remains a feasibility patch, not an audited engine release. It does not
implement AsyncResource or the full async_hooks API. A small shared-object
cross-realm ALS corpus passes, not comprehensive cross-realm conformance.
The public sandbox supports bounded child contexts within one runtime. Custom
module-loader context semantics, finalization callbacks, broader allocation-failure
coverage, and upstream conformance still need work. The native-browser
backend and original synchronous-I/O Asyncify variant are unchanged.

## Combined engine

The combined backend has not passed the desktop stability gate. Earlier runs
failed on high WebKit compiler memory after execution. See
[the findings](../SPIKE-FINDINGS.md). Passing the functional suite does not
establish desktop Safari or phone support.

`quickjs-async-dispose.patch` keeps the host callback registry alive until
`QTS_FreeRuntime` finishes its finalizers, matching the synchronous wrapper's
disposal order. Completion now waits for context/runtime disposal, so cleanup
errors fail execution instead of arriving after a successful result.

For compiler-shape experiments, `--opt=O1` or `--opt=O2` writes a separate
`public/quickjs-als-asyncify-o1` or `-o2` build with matching glue and metadata.
Set `ENGINE_PROFILE=o1` or `o2` on the memory probe to select it through request
interception. Neither profile changes the default runtime or fixes the desktop
gate. Do not replace only the WASM beneath another build's glue.

```sh
npm run build:combined
npm run probe:combined
```

The same source checkout and Emscripten SDK build `public/quickjs-als-asyncify`.
The script checks and applies both recorded patches. `--asyncify` also builds
the matching upstream debug FFI and wrapper source with the upstream
assignment-style class-field semantics. Assertions remain enabled. Generated
glue, bindings, wrapper, and WASM must stay together.

`quickjs-async-job-drain.patch` adds `executePendingJobsAsync`. Its caller must
serialize VM entry. The combined worker queues host promise settlements and
timer completions while Asyncify is suspended. Timer callbacks run as guest
promise jobs, so they can suspend for synchronous file calls too.

```ts
await workspace.executeInVM('/main.mjs', {
  engine: 'quickjs-als-asyncify',
  webAPIs: true, // Optional data-type polyfills, no network transport.
  maxBytes: 64 * 1024 * 1024,
})
```

`npm run build:vm-web-apis` builds the optional guest globals and records their
hash, package versions, and licenses in `public/vm-web-apis`. These APIs run
inside the VM. The real Start probe uses packages' `workerd` export profile to
select edge-server entries, not a workerd runtime or an app-specific rewrite.
The default browser compilation path is unchanged.

See `tests/feasibility/combined-engine.spec.ts` for the 34-case ALS corpus,
suspended I/O, streamed UTF-8, request cloning, full Start SSR responses,
phone action, authority, interruption, cancellation, and recovery checks.
This still does not implement a persistent Node process, arbitrary Node package
support, an interactive VM preview, or comprehensive Web API conformance.
