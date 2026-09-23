import {readFile,writeFile} from 'node:fs/promises'
const inputs=(process.argv[2]??'reports/workload-browser-results.json').split(',')
const outputPrefix=process.argv[3]??'reports/workload'
const runs=await Promise.all(inputs.map(async input=>JSON.parse(await readFile(input,'utf8'))))
if(runs.length>1&&runs.some(run=>!run.config?.metadata?.kernelBuiltins||!run.config?.metadata?.kernelEngine||!run.config?.metadata?.guestWebAPIs))throw Error('Cannot combine runs without tested artifact fingerprints')
if(runs.some(run=>JSON.stringify(run.config?.metadata)!==JSON.stringify(runs[0].config?.metadata)))throw Error('Cannot combine runs with different tested artifacts')
const raw=runs.length===1?runs[0]:{...runs[0],suites:runs.flatMap(run=>run.suites??[]),stats:{
  startTime:runs.map(run=>run.stats.startTime).sort()[0],
  ...Object.fromEntries(['duration','expected','skipped','unexpected','flaky'].map(key=>[key,runs.reduce((sum,run)=>sum+(run.stats[key]??0),0)])),
}}
const sourceRuns=inputs.map((input,index)=>({input,stats:runs[index].stats}))
const manifest=JSON.parse(await readFile('public/workloads/manifest.json','utf8'))
// Capture the tested build, not whichever engine happens to be on disk when
// an old report is summarized. Older runs did not record this fingerprint.
const engine=raw.config?.metadata?.kernelEngine??null
const rows=[],native=[],apps=[],semantics=[],modules=[],nodeCore=[],guestVM=[],contextPrimitives=[],contextGlobals=[],vmContexts=[],allocators=[],portableCore=[],filesystem=[],symlinks=[],streams=[],immediates=[],resolution=[],failures=[]
const testsSeen=new Set()
async function visit(suite){
  for(const spec of suite.specs??[])for(const test of spec.tests??[]){
    const key=JSON.stringify([spec.file,spec.title,test.projectName])
    if(testsSeen.has(key))throw Error('Duplicate test in report inputs: '+key)
    testsSeen.add(key)
    const run=test.results.at(-1)
    if(spec.title.startsWith('kernel semantics | '))semantics.push({browser:test.projectName,name:spec.title.slice('kernel semantics | '.length),status:run?.status})
    if(spec.title.startsWith('runtime modules | '))modules.push({browser:test.projectName,name:spec.title.slice('runtime modules | '.length),status:run?.status})
    if(spec.title.startsWith('Node core | '))nodeCore.push({browser:test.projectName,name:spec.title.slice('Node core | '.length),status:run?.status})
    if(spec.title.startsWith('Node VM | '))guestVM.push({browser:test.projectName,name:spec.title.slice('Node VM | '.length),status:run?.status})
    if(spec.title.startsWith('Portable core | '))portableCore.push({browser:test.projectName,name:spec.title.slice('Portable core | '.length),status:run?.status})
    if(spec.title.startsWith('Filesystem | '))filesystem.push({browser:test.projectName,name:spec.title.slice('Filesystem | '.length),status:run?.status})
    if(spec.title.startsWith('Symlinks | '))symlinks.push({browser:test.projectName,name:spec.title.slice('Symlinks | '.length),status:run?.status})
    if(spec.title.startsWith('Node streams | '))streams.push({browser:test.projectName,name:spec.title.slice('Node streams | '.length),status:run?.status})
    if(spec.title.startsWith('Node immediates | '))immediates.push({browser:test.projectName,name:spec.title.slice('Node immediates | '.length),status:run?.status})
    if(spec.file?.endsWith('/resolution.spec.ts')||spec.file==='resolution.spec.ts')resolution.push({browser:test.projectName,name:spec.title,status:run?.status})
    if(run?.status!=='passed')failures.push({project:test.projectName,title:spec.title,status:run?.status,error:run?.error})
    for(const attachment of run?.attachments??[]){
      if(!['workload.json','browser-runtime.json','browser-app.json','context-primitives.json','context-globals.json','vm-context.json','allocator.json'].includes(attachment.name))continue
      const contents=attachment.body?Buffer.from(attachment.body,'base64').toString():await readFile(attachment.path,'utf8')
      const row={browser:test.projectName,...JSON.parse(contents)}
      if(attachment.name==='workload.json')rows.push(row)
      else if(attachment.name==='browser-runtime.json')native.push(row)
      else if(attachment.name==='context-primitives.json')contextPrimitives.push({...row,status:run?.status})
      else if(attachment.name==='context-globals.json')contextGlobals.push({...row,status:run?.status})
      else if(attachment.name==='vm-context.json')vmContexts.push({...row,status:run?.status})
      else if(attachment.name==='allocator.json')allocators.push({...row,status:run?.status})
      else apps.push(row)
    }
  }
  for(const child of suite.suites??[])await visit(child)
}
for(const suite of raw.suites??[])await visit(suite)
const baseline=JSON.parse(await readFile('compat/workload-baseline.json','utf8'))
for(const row of rows)if(baseline[row.browser]?.includes(row.id)&&!['pass','adapted-pass'].includes(row.status)){
  failures.push({project:row.browser,title:row.id,status:'compatibility regression',error:row.error})
}
const report={generatedAt:new Date().toISOString(),node:manifest.node,lockSHA256:manifest.lockSHA256,engine,packages:manifest.packages,
  testedArtifacts:raw.config?.metadata??null,testRun:raw.stats,sourceRuns,
  preparation:manifest.preparation,kernel:rows,browserNative:native,browserApps:apps,kernelSemantics:semantics,runtimeModules:modules,nodeCore,guestVM,contextPrimitives,contextGlobals,vmContexts,allocators,portableCore,filesystem,symlinks,streams,immediates,resolution,harnessFailures:failures}
await writeFile(outputPrefix+'-matrix.json',JSON.stringify(report,null,2))
const browsers=[...new Set(rows.map(x=>x.browser))]
const escape=value=>String(value??'').replaceAll('|','\\|').replaceAll('\n',' ').replaceAll('\r',' ')
const lines=['# Workload experiments','',
  'A pass applies only to the named operation. It is not full package, framework, Node, or WebContainer compatibility.',
  '',`Node reference: ${manifest.node}. Package-lock SHA-256: ${manifest.lockSHA256}.`]
if(raw.config?.metadata?.runtimeSourceSHA256)lines.push('',`Runtime source SHA-256: ${raw.config.metadata.runtimeSourceSHA256}.`)
if(inputs.length>1)lines.push('',`Combined evidence from ${inputs.length} separate test-runner launches, not a single-run pass. Recorded engine, builtin, and guest Web API fingerprints match and test identities do not overlap. This does not resolve the separately recorded WebKit test-browser lifecycle failure.`,
  '',...sourceRuns.map(run=>`- ${run.input}: ${run.stats.expected} expected outcomes, ${run.stats.unexpected} unexpected, ${run.stats.skipped} skipped.`))
if(rows.length){
lines.push(
  '',manifest.preparation,
  '', 'Kernel passes require matching initial, edited, repeated, and restored outputs. Configured guest limits: 64 MiB allocation, 10 seconds per execution, 32 MiB workspace, 8 MiB UTF-8 source. Guest bundles omit whitespace, retaining identifiers and native async syntax. Browser builds have separate limits.',
  '', engine?.allocatorAccounting==='malloc_usable_size'?'This engine accounts for retained guest allocations and reallocations. The guest limit is not a total WASM or browser-process memory limit.':'This older engine does not establish aggregate guest memory enforcement. Its Emscripten allocator returned zero usable allocation bytes, allowing retained allocations and reallocations to exceed the configured limit.',
  '',`| Kernel workload | Execution | Scope | ${browsers.join(' | ')} | First observed blocker |`,
  `| --- | --- | --- | ${browsers.map(()=>'---').join(' | ')} | --- |`)
for(const fixture of manifest.cases){
  const results=browsers.map(browser=>rows.find(x=>x.browser===browser&&x.id===fixture.id))
  const failed=results.find(x=>x?.error)
  lines.push(`| ${fixture.id} | ${fixture.execution??'bundle'} | ${escape(fixture.scope)} | ${results.map(x=>x?.status??'not run').join(' | ')} | ${escape(failed?failed.stage+': '+failed.error.slice(0,400):fixture.adaptation??'')} |`)
}
}
if(native.length){
lines.push('','## Separate browser workers','','These execute outside QuickJS in trusted workers. They are not evidence of safe arbitrary plugins or guest WASM support. Each performs four operations with inputs 3, 7, 7, 3 and must return 6, 14, 14, 6. Runtime assets are served locally and external requests are blocked.','',
  '| Runtime | Browser | Result |','| --- | --- | --- |')
for(const row of native)lines.push(`| ${row.runtime??'unknown'} | ${row.browser} | ${row.status}: ${escape(row.error??JSON.stringify(row.values))} |`)
}
if(apps.length){
lines.push('','## Interactive apps','','These use the trusted pinned browser Vite toolchain and an opaque DOM iframe, not QuickJS. Every run verifies the counter, emitted CSS, and image asset, then repeats after edits and restoration. Svelte compilation runs in a separate browser worker. This is client mounting, not SSR hydration or HMR.','',
  '| Framework | Browser | Result |','| --- | --- | --- |')
for(const row of apps)lines.push(`| ${row.framework} | ${row.browser} | ${row.status}, ${row.iterations.length} builds |`)
}
if(semantics.length){
lines.push('','## Kernel runtime checks','','Event, abort, message, timer, and EventEmitter results are compared with Node. Separate checks cover host-edited filesystem watches, recursive watch and abort, resource quotas, callback errors, and recovery.','',
  '| Check | Browser | Result |','| --- | --- | --- |')
for(const row of semantics)lines.push(`| ${row.name} | ${row.browser} | ${row.status} |`)
}
if(modules.length){
lines.push('','## Runtime module loading','','Unbundled CommonJS and ESM run against the worker-owned filesystem. Fixtures compare output with Node, including bare-dot directory requires. Separate checks exercise live host edits, authority, interrupted execution, import failures, and recovery.','',
  '| Check | Browser | Result |','| --- | --- | --- |')
for(const row of modules)lines.push(`| ${row.name} | ${row.browser} | ${row.status} |`)
}
if(nodeCore.length){
lines.push('','## Node core APIs','','Node comparisons cover utilities, promisify, assertions, hashes/HMAC, random API shape, timing, observer context, and callback filesystem operations in bundled and unbundled execution. Separate tests cover the virtual process policy, read-only authority, and resource limits.','',
  '| Check | Browser | Result |','| --- | --- | --- |')
for(const row of nodeCore)lines.push(`| ${escape(row.name)} | ${row.browser} | ${row.status} |`)
}
if(guestVM.length){
lines.push('','## Compiled guest scripts','','QuickJS compiles and executes scripts in the existing guest realm. Node comparisons cover persistent bindings, repeat execution, raw values and promises, source offsets, catchable local deadlines, overlapping ALS context, and rejected dynamic imports. Separate checks retain outer deadlines, heap limits, filesystem policy, and recovery.','',
  '| Check | Browser | Result |','| --- | --- | --- |')
for(const row of guestVM)lines.push(`| ${escape(row.name)} | ${row.browser} | ${row.status} |`)
}
if(contextPrimitives.length){
  lines.push('','## VM context engine primitives','','Worker-hosted engine checks cover separate realms, shared values, cross-context ALS, code-generation restrictions, and nested deadlines. These do not implement node:vm sandbox-object bridging or establish Webpack compatibility. Each browser test repeats the corpus in three fresh runtimes.','',
    '| Browser | Cases per round | Rounds | Result |','| --- | --- | --- | --- |')
  for(const row of contextPrimitives)lines.push(`| ${row.browser} | ${row.rounds?.[0]?.length??0} | ${row.rounds?.length??0} | ${row.status} |`)
}
if(contextGlobals.length){
  lines.push('','## Candidate live-global engine bridge','','These tests use a separate candidate engine, identified by the attachment hash below, not the kernel engine recorded above. Node comparisons cover live sandbox properties, declarations, descriptors, cross-realm compiled scripts, and policy/deadline controls. They do not establish public node:vm context support or Webpack compatibility.','',
    '| Browser | Global scenarios per round | Rounds | Candidate WASM SHA-256 | Result |','| --- | --- | --- | --- | --- |')
  for(const row of contextGlobals)lines.push(`| ${row.browser} | ${row.rounds?.[0]?.globals?.length??0} | ${row.rounds?.length??0} | ${row.build?.wasmSha256??'unrecorded'} | ${row.status} |`)
}
if(vmContexts.length){
  lines.push('','## Public VM contexts','','The worker kernel exposes createContext, isContext, runInContext and runInNewContext. Each fixture runs bundled and unbundled. Policy rows are separate from Node comparisons; generated imports are denied even where Node permits them. Context creation is capped at 64 attempts per execution.','',
    '| Check | Kind | Browser | Result |','| --- | --- | --- | --- |')
  for(const row of vmContexts)lines.push(`| ${escape(row.name)} | ${row.kind} | ${row.browser} | ${row.status} |`)
}
if(allocators.length){
  lines.push('','## Allocator accounting','','The engine uses Emscripten malloc_usable_size to count retained allocations and reallocations. Each worker tests aggregate limits and recovery, then 1,025 context-creation allocation-pressure points. This is a guest allocator budget, not a total WASM or browser-process memory ceiling. Older builds returning zero usable bytes did not enforce aggregate allocation budgets.','',
    '| Browser | Allocation attempts | Failures exercised | Successful creations | Result |','| --- | --- | --- | --- | --- |')
  for(const row of allocators)lines.push(`| ${row.browser} | ${row.allocation?.length??0} | ${row.allocation?.filter(x=>x.failed).length??0} | ${row.allocation?.filter(x=>!x.failed).length??0} | ${row.status} |`)
}
if(portableCore.length){
lines.push('','## Paths, query strings, and Buffer','','Pinned Node 24.15 path and querystring implementations run inside the guest. Differential fixtures include Windows paths on the virtual POSIX process, malformed UTF-8, custom codecs, and prototype-sensitive keys. Buffer decoding compares a deterministic corpus with Node, with and without optional Web APIs.','',
  '| Check | Browser | Result |','| --- | --- | --- |')
for(const row of portableCore)lines.push(`| ${escape(row.name)} | ${row.browser} | ${row.status} |`)
}
if(filesystem.length){
  lines.push('','## Filesystem operations','','Node comparisons cover empty directories, recursive listing, shared Dirent identity, rename/removal, write flags, byte views, encodings, copy/truncate, callback and promise APIs, and ALS. Separate checks cover read-only authority, quota failures, checkpoint restoration, and recovery. Directory unlink accepts the documented macOS/Linux error-code difference.','',
    '| Check | Browser | Result |','| --- | --- | --- |')
  for(const row of filesystem)lines.push(`| ${escape(row.name)} | ${row.browser} | ${row.status} |`)
}
if(symlinks.length){
  lines.push('','## Symbolic links','','Node comparisons cover relative, absolute, dangling, and cyclic links; stat/lstat and shared Stats identity; alias directory listing; linked writes, copying, rename, and deletion; callbacks, promises, encodings, and ALS. Separate checks cover canonical CommonJS/ESM identity, linked package compilation, checkpoint restoration, and read-only authority.','',
    '| Check | Browser | Result |','| --- | --- | --- |')
  for(const row of symlinks)lines.push(`| ${escape(row.name)} | ${row.browser} | ${row.status} |`)
}
if(streams.length){
  lines.push('','## Node streams and process output','','Node comparisons cover pipelines, backpressure, cancellation, early iterator exit, ALS, shared types, and guest-local Web Stream adapters. Separate checks cover the 1 MiB combined output quota, recovery, and operation without optional Web APIs.','',
    '| Check | Browser | Result |','| --- | --- | --- |')
  for(const row of streams)lines.push(`| ${escape(row.name)} | ${row.browser} | ${row.status} |`)
}
if(immediates.length){
  lines.push('','## Immediate callbacks','','The worker owns a bounded immediate queue. Node comparisons cover FIFO order, intervening microtasks, cancellation, ref/unref, callback arguments, and ALS. Separate checks cover queue quotas, callback failures, deadlines, and recovery.','',
    '| Check | Browser | Result |','| --- | --- | --- |')
  for(const row of immediates)lines.push(`| ${escape(row.name)} | ${row.browser} | ${row.status} |`)
}
lines.push('','## Limits of this evidence','',
  '- Source graphs are prepared on the host, not installed from npm in the browser. Partial discovery graphs are retained and identified in workload-preparation.json.',
  '- No package source is patched to create a pass. Package browser conditions and explicit standalone/edge entrypoints can differ from Node entrypoints.',
  '- SvelteKit helper results do not establish a complete SvelteKit app. Astro container and Next preparation are separate, narrower probes.',
  '- Chromium, Firefox, and Playwright WebKit on this Mac do not certify installed Safari, Edge, Windows, Linux, or phones.',
  '- Worker teardown is tested, but this suite is not a long-session memory or security certification.',
  '- Message channels are guest-local. Transfer lists, cross-worker port transfer, and complete structured-clone coverage are not implemented.',
  '- Filesystem watches cover the tested file/directory, recursive, close, abort, and reference-lifetime operations. Descriptors, fs.watchFile, fs.promises.watch, and full watch behavior when links are retargeted remain separate gaps.',
  '- Filesystem metadata remains minimal. Modes, flush, abort signals, file descriptors, file streams, and full relative-path, trailing-slash, and callback-argument parity are not established. Version 3 checkpoints retain links and empty directories and can still load version 1 and 2 snapshots. Link resolution is capped at 40 hops and cannot escape the virtual root. Archive writes refuse existing links in every path component.',
  '- Timer, immediate, watcher, and filename-worker lifetime is implemented for the tested resources. The immediate queue is capped at 128 and yields to the host between callbacks. Full Node event-loop phases, exact timer-versus-immediate ordering, unhandled-rejection reporting, and complete worker-thread semantics remain incomplete.',
  '- Runtime loading is opt-in through runModule(). Synchronous require(ESM), JSON import-attribute enforcement, import.meta.resolve, preserve-symlinks options, and Node syntax detection for ambiguous .js files are not implemented.',
  '- Runtime loading limits each source file to 8 MiB, cumulative source reads to 32 MiB per execution, and package metadata to 1 MiB per file. Bundled execution remains a separate path.',
  '- OS identity describes a single-threaded virtual sandbox, not the physical host. Physical OS metrics remain unavailable. Filename workers use distinct guest runtimes on the shared browser scheduler, not parallel host threads. Eval workers, transfer lists, shared memory, and complete structured-clone behavior remain unsupported.',
  '- Crypto covers the tested hashing, HMAC, and randomness operations. Hash copies, most hash options, encryption, signatures, key objects, TLS, Web Crypto subtle, and timingSafeEqual remain unsupported. No security or constant-time certification is implied.',
  '- Randomness uses the browser CSPRNG through copied bytes, capped at 1 MiB per public request and 4 MiB per execution. No weak-entropy fallback is used.',
  '- User timing supports mark/measure entries with bounded observer delivery. Entries and observer queues are capped at 1024, observers at 128. Complete perf_hooks coverage and Node event-loop phase ordering are not established.',
  '- Utilities and assertions use browser-oriented compatibility libraries. The fixtures do not establish every modern Node formatting, inspection, comparison, or error-validation edge case.',
  '- Node streams use readable-stream 4.7.0 with guest-local Web Stream adapters. Complete modern Node stream parity, every adapter option, and Web Stream state inspection are not established. Process stdout/stderr transport is implemented in WorkerKernel; other backends reject writes. Console and stdio share a 1 MiB quota; appended failure diagnostics still need a separate bound. There is no stdin or pseudo-terminal device.',
  '- node:vm supports Script compilation, separate contexts, and the tested cross-realm operations. Context creation is capped at 64 attempts per execution, with shared runtime allocation and outer CPU budgets. Code caches, VM module objects, compileFunction, custom dynamic-import callbacks and afterEvaluate microtask mode remain unsupported. Child contexts do not automatically inherit host capabilities. Stack formatting is QuickJS, not V8. Exact source-offset, Proxy-sandbox, and argument-validation parity is not established.',
  '- Path operations describe a virtual POSIX process, with Windows path helpers available separately. path.matchesGlob is unsupported. Error codes are tested, not exact Node error-message wording.',
  '- The shared Buffer build has a source-hash-checked UTF-8 decoder correction. This is a compatibility-library patch, not a guest application or workload-package patch. Corpus agreement does not establish all Buffer APIs.',
  '- Workspace policy also limits paths to 4096 UTF-8 bytes and entries to 16384, counting files, links, and non-root directories. Link target bytes count toward the workspace byte quota. Watchers and timers are each capped at 128, with 256 queued events per watcher or message port.',
  '',`Harness failures: ${failures.length}. Test-runner success counts completed experiments, not compatible packages.`)
await writeFile(outputPrefix+'-summary.md',lines.join('\n')+'\n')
for(const browser of browsers){
  const results=rows.filter(x=>x.browser===browser)
  console.log(browser,JSON.stringify(Object.fromEntries(['pass','adapted-pass','gap','fixture-error','preparation-blocked'].map(status=>[status,results.filter(x=>x.status===status).length]))))
}
console.log('Browser runtimes:',native.length,'Interactive apps:',apps.length,'Harness failures:',failures.length)
if(failures.length)process.exitCode=1
