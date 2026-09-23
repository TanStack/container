import { Workspace } from './workspace'
import { checkpoint } from './persistence'
import { Preview } from './preview'
import { URLPreview } from './url-preview'
import { runWorkflow, workflowFiles } from './workflow'
import { loadBrowserViteEngine } from '../vite-browser/client'
import { buildStartFixtureInBrowser } from '../start-fixture/browser-build'
import { probeVM } from './vm'
import { runCompatibility, compatibilityCaseCount } from '../feasibility/runner'
import { runSynchronousIO } from '../feasibility/sync-io'
import { runEngineALS } from '../feasibility/engine-als'
import { runCombinedIO, runCombinedStart } from '../feasibility/combined-engine'
import {WorkerKernel} from './kernel'
import {runMvdanShell} from './mvdan-shell'
import {WorkerHTTP} from './worker-http'
import {WorkerWebSocket} from './worker-websocket'
import {runWorkerKernel} from '../feasibility/worker-kernel'
import {runWorkload,runWorkloads} from '../feasibility/workloads'
import './lab.css'

declare global {
  interface Window {
    sandboxLab: {
      Workspace: typeof Workspace
      WorkerKernel: typeof WorkerKernel
      runMvdanShell: typeof runMvdanShell
      WorkerHTTP: typeof WorkerHTTP
      WorkerWebSocket: typeof WorkerWebSocket
      runWorkerKernel: typeof runWorkerKernel
      runWorkload: typeof runWorkload
      runWorkloads: typeof runWorkloads
      checkpoint: typeof checkpoint
      Preview: typeof Preview
      URLPreview: typeof URLPreview
      runWorkflow: typeof runWorkflow
      workflowFiles: typeof workflowFiles
      loadBrowserViteEngine: typeof loadBrowserViteEngine
      buildStartFixtureInBrowser: typeof buildStartFixtureInBrowser
      probeVM: typeof probeVM
      runCompatibility: typeof runCompatibility
      runSynchronousIO: typeof runSynchronousIO
      runEngineALS: typeof runEngineALS
      runCombinedIO: typeof runCombinedIO
      runCombinedStart: typeof runCombinedStart
    }
  }
}
window.sandboxLab = {
  Workspace,
  WorkerKernel,
  runMvdanShell,
  WorkerHTTP,
  WorkerWebSocket,
  runWorkerKernel,
  runWorkload,
  runWorkloads,
  checkpoint,
  Preview,
  URLPreview,
  runWorkflow,
  workflowFiles,
  loadBrowserViteEngine,
  buildStartFixtureInBrowser,
  probeVM,
  runCompatibility,
  runSynchronousIO,
  runEngineALS,
  runCombinedIO,
  runCombinedStart,
}
let active: { workspace: Workspace; preview: Preview | URLPreview } | undefined
document.querySelector('#workloads')!.addEventListener('click',()=>run(async()=>{
  const report=await runWorkloads(row=>log(`${row.status.toUpperCase()} ${row.id}${row.error?'\n'+row.error.slice(0,500):''}`))
  const link=document.createElement('a')
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}))
  link.href=url;link.download='sandbox-workloads.json';link.textContent='Download workload report'
  document.querySelector('#preview')!.replaceChildren(link)
  link.addEventListener('click',()=>setTimeout(()=>URL.revokeObjectURL(url),60000),{once:true})
}))
document.querySelector('#worker-kernel')!.addEventListener('click',()=>run(async()=>{
  const report=await runWorkerKernel(log)
  log('Functional checks finished. Use the desktop memory probe to check stability.')
  const link=document.createElement('a')
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}))
  link.href=url;link.download='sandbox-worker-kernel.json';link.textContent='Download worker-owned VM report'
  document.querySelector('#preview')!.replaceChildren(link)
  link.addEventListener('click',()=>setTimeout(()=>URL.revokeObjectURL(url),60000),{once:true})
}))
document.querySelector('#combined-engine')!.addEventListener('click',()=>run(async()=>{
  const als=await runEngineALS(result=>{
    document.querySelector('#output')!.textContent+=`${result.status.toUpperCase()} ${result.id}\n`
  },'quickjs-als-asyncify')
  const matches=als.results.filter(x=>x.status==='match').length
  log(`${matches}/${als.results.length} ALS cases matched Node.`)
  if(matches!==als.results.length)throw new Error('Combined ALS comparison failed')
  const io=await runCombinedIO()
  log('PASS: native await + live sync/async files + timers.')
  const start=await runCombinedStart(log)
  log('PASS: three overlapping Start requests, complete HTML, two routes, inside QuickJS.')
  log('Functional checks finished. Memory stability is not verified by this action.')
  const link=document.createElement('a')
  const url=URL.createObjectURL(new Blob([JSON.stringify({als,io,start},null,2)],{type:'application/json'}))
  link.href=url;link.download='sandbox-combined-engine.json';link.textContent='Download combined report'
  document.querySelector('#preview')!.replaceChildren(link)
  link.addEventListener('click',()=>setTimeout(()=>URL.revokeObjectURL(url),60000),{once:true})
}))
document.querySelector('#engine-als')!.addEventListener('click', () => run(async () => {
  const report = await runEngineALS(result => {
    document.querySelector('#output')!.textContent += `${result.status.toUpperCase()} ${result.id}\n`
  })
  const matches = report.results.filter(x=>x.status==='match').length
  document.querySelector('#output')!.textContent += `\n${matches}/${report.results.length} matched Node ${report.node}. Native await, no async transform.\n`
  const link = document.createElement('a')
  const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)], {type:'application/json'}))
  link.href=url
  link.download='sandbox-engine-als.json'
  link.textContent='Download ALS report'
  document.querySelector('#preview')!.replaceChildren(link)
  link.addEventListener('click',()=>setTimeout(()=>URL.revokeObjectURL(url),60000),{once:true})
}))
const log = (text: string) => {
  const output = document.querySelector('#output')!
  if (/^Installing \d+\/\d+ packages/.test(text)) {
    output.textContent = output.textContent!.replace(
      /Installing \d+\/\d+ packages…\n$/,
      '',
    )
  }
  output.textContent += text + '\n'
}
document.querySelector('#compatibility')!.addEventListener('click', () =>
  run(async () => {
    const synchronousIO = await runSynchronousIO()
    log(
      'PASS: live synchronous filesystem, 100 reads, read-only enforcement, no SharedArrayBuffer.',
    )
    let completed = 0
    const compatibility = await runCompatibility((result) => {
      document.querySelector('#output')!.textContent =
        `Synchronous I/O: passed\nCompatibility: ${++completed}/${compatibilityCaseCount}\n${result.status.toUpperCase()} ${result.backend}: ${result.id}\n`
    })
    const report = { ...compatibility, synchronousIO }
    const link = document.createElement('a')
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    )
    link.href = url
    link.download = 'sandbox-compatibility.json'
    link.textContent = 'Download feasibility report'
    document.querySelector('#preview')!.replaceChildren(link)
    const matches = report.results.filter((x) => x.status === 'match').length
    document.querySelector('#output')!.textContent =
      `Synchronous I/O: passed\n${matches}/${report.results.length} cases matched Node ${report.node}.\n${report.results.length - matches} compatibility gaps. See the report for each result.\n`
    link.addEventListener(
      'click',
      () => setTimeout(() => URL.revokeObjectURL(url), 60000),
      { once: true },
    )
  }),
)
async function run(operation: () => Promise<void>) {
  const buttons = [...document.querySelectorAll('button')]
  buttons.forEach((button) => {
    button.disabled = true
  })
  active?.preview.close()
  active?.workspace.close()
  document.querySelector('#output')!.textContent = ''
  try {
    await operation()
  } catch (error) {
    log(String(error))
  } finally {
    buttons.forEach((button) => {
      button.disabled = false
    })
  }
}
document.querySelector('#run')!.addEventListener('click', () =>
  run(async () => {
    active = await runWorkflow(document.querySelector('#preview')!, log)
  }),
)
document.querySelector('#vm-probe')!.addEventListener('click', () =>
  run(async () => {
    for (const [name, code] of [
      ['Arithmetic', '6 * 7'],
      ['Infinite loop', 'while(true){}'],
      ['Heap limit', '"x".repeat(4 * 1024 * 1024)'],
      [
        'Ambient APIs',
        'JSON.stringify({fetch: typeof fetch, document: typeof document, process: typeof process})',
      ],
    ]) {
      const result = await probeVM(code)
      log(
        `${name}: ${JSON.stringify(result.value)} (${result.bootMs.toFixed(0)}ms boot, ${result.executionMs.toFixed(0)}ms execution)`,
      )
    }
  }),
)
document.querySelector('#vm-workflow')!.addEventListener('click', () =>
  run(async () => {
    const workspace = new Workspace({
      files: {
        ...workflowFiles,
        '/save.ts': `import { writeFile, readFile } from 'node:fs/promises'; import { add } from './math'; await writeFile('/answer.txt', String(add(2, 3))); console.log(await readFile('/answer.txt', 'utf8'))`,
      },
    })
    try {
      const failed = await workspace.executeInVM('/test.ts')
      if (!failed.exitCode) throw new Error('Broken test unexpectedly passed')
      log('Expected failure before repair: ' + failed.stderr)
      await workspace.files.patch('/math.ts', 'a - b', 'a + b')
      const passed = await workspace.executeInVM('/test.ts')
      if (passed.exitCode) throw new Error(passed.stderr)
      log(passed.stdout.trim())
      const saved = await workspace.executeInVM('/save.ts')
      if (saved.exitCode) throw new Error(saved.stderr)
      log('/answer.txt: ' + saved.stdout.trim())
      await workspace.save('quickjs-workflow')
      const restored = await Workspace.open('quickjs-workflow')
      try {
        const replay = await restored.executeInVM('/test.ts')
        if (replay.exitCode) throw new Error(replay.stderr)
        log('Checkpoint restored, test passed in QuickJS')
      } finally {
        restored.close()
      }
    } finally {
      workspace.close()
    }
  }),
)
document.querySelector('#start-probe')!.addEventListener('click', () =>
  run(async () => {
    const build = await buildStartFixtureInBrowser(log)
    const workspace = new Workspace({ files: build.artifacts })
    try {
      const server = await workspace.serveCode(build.code, {
        timeoutMs: 10_000,
      })
      const assets = Object.fromEntries(
        Object.entries(build.artifacts)
          .filter(([path]) => path.startsWith('/app/dist/client/'))
          .map(([path, bytes]) => [
            path.slice('/app/dist/client'.length),
            bytes,
          ]),
      )
      const preview = await URLPreview.mount(
        document.querySelector('#preview')!,
        {
          origin:
            import.meta.env.VITE_SANDBOX_PREVIEW_ORIGIN ??
            'http://127.0.0.1:4174',
          server,
          assets,
        },
      )
      active = { workspace, preview }
      await new Promise((resolve) => setTimeout(resolve, 300))
      log(
        preview.diagnostics.length
          ? preview.diagnostics.join('\n')
          : `Preview: ${preview.origin}\nTry the counter, server call, and About link.`,
      )
    } catch (error) {
      workspace.close()
      throw error
    }
  }),
)
