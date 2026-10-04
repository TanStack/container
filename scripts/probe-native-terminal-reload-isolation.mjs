import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const checks = {
  baseline: [],
  toggle: ['NATIVE_TOGGLE_TERMINAL'],
  'long-edit': ['NATIVE_LONG_EDIT'],
  'clear-edit': ['NATIVE_CLEAR_EDIT'],
  'word-edit': ['NATIVE_WORD_EDIT'],
  resize: ['NATIVE_RESIZE'],
  edits: ['NATIVE_LONG_EDIT', 'NATIVE_CLEAR_EDIT', 'NATIVE_WORD_EDIT'],
  'edits-resize': ['NATIVE_LONG_EDIT', 'NATIVE_CLEAR_EDIT', 'NATIVE_WORD_EDIT', 'NATIVE_RESIZE'],
  'toggle-resize': ['NATIVE_TOGGLE_TERMINAL', 'NATIVE_RESIZE'],
  combined: ['NATIVE_LONG_EDIT', 'NATIVE_CLEAR_EDIT', 'NATIVE_WORD_EDIT', 'NATIVE_TOGGLE_TERMINAL', 'NATIVE_RESIZE'],
}

export function isolationPlan(env = process.env) {
  const browser = env.NATIVE_BROWSER || 'firefox'
  assert.ok(['chromium', 'firefox', 'webkit'].includes(browser), 'NATIVE_BROWSER must be chromium, firefox or webkit')
  assert.ok(env.NATIVE_HEADLESS === undefined || ['0', '1'].includes(env.NATIVE_HEADLESS), 'NATIVE_HEADLESS must be 0 or 1')
  const headless = env.NATIVE_HEADLESS !== '0'
  const repetitions = Number(env.NATIVE_ISOLATION_REPETITIONS ?? 3)
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10, 'NATIVE_ISOLATION_REPETITIONS must be an integer from 1 to 10')
  const cases = env.NATIVE_ISOLATION_CASES === undefined ? Object.keys(checks) : env.NATIVE_ISOLATION_CASES.split(',')
  assert.ok(cases.length > 0 && cases.every(name => Object.hasOwn(checks, name)) && new Set(cases).size === cases.length,
    'NATIVE_ISOLATION_CASES must contain unique known case names')
  return { browser, headless, repetitions, cases: cases.map(name => ({ name, flags: [...checks[name]] })) }
}

export function isolationEnvironment(env, plan, scenario, directory) {
  // Do not let inherited experimental flags silently change an isolation case.
  const forwarded = new Set(['NATIVE_SITE_ORIGIN', 'NATIVE_PREVIEW_ORIGIN', 'NATIVE_VIEWPORT_WIDTH', 'NATIVE_VIEWPORT_HEIGHT'])
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('NATIVE_') || forwarded.has(key)))
  return { ...clean, NATIVE_BROWSER: plan.browser, NATIVE_TERMINAL_REPETITIONS: String(plan.repetitions),
    NATIVE_HEADLESS: plan.headless ? '1' : '0',
    NATIVE_SCROLLBACK_FOLLOW: '1', NATIVE_EDITOR_TO_TERMINAL: '1', NATIVE_TRACE_PROGRESS: '1',
    ...Object.fromEntries(scenario.flags.map(flag => [flag, '1'])),
    NATIVE_TERMINAL_FAILURE_REPORT: join(directory, scenario.name + '-failure.json'),
    NATIVE_TERMINAL_FAILURE_CAPTURE: join(directory, scenario.name + '-failure.png'),
  }
}

export function isolationPassed(result, repetitions, completedRuns) {
  return result.code === 0 && result.signal === null && result.error === undefined &&
    Number.isSafeInteger(repetitions) && repetitions > 0 && completedRuns === repetitions
}

async function main() {
  const plan = isolationPlan()
  assert.ok(process.env.NATIVE_SITE_FIXTURE, 'Pass NATIVE_SITE_FIXTURE from the running isolated site')
  const fixture = await realpath(process.env.NATIVE_SITE_FIXTURE)
  assert.match(fixture, /^\/private\/tmp\/tanstack-native-site-[A-Za-z0-9]+$/, 'Use a prepared temporary site fixture')
  const identity = JSON.parse(await readFile(join(fixture, '.native-local/identity.json'), 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  for (const item of identity.integrations) {
    assert.ok(['ExampleNativeWorkbench.client.tsx', 'NativeTerminal.client.tsx', 'native-terminal-word.ts', 'local-native-examples.mjs'].includes(item.filename))
    const file = join(fixture, item.filename.endsWith('.mjs') ? 'scripts' : 'src/components/examples', item.filename)
    assert.equal(hash(await readFile(file)), item.sha256, 'Fixture integration changed: ' + item.filename)
  }
  assert.equal(hash(await readFile(join(identity.sdk, 'package-assets.json'))), identity.sdkSHA256, 'Installed SDK inventory changed')
  const directory = await mkdtemp(join(tmpdir(), 'native-terminal-reload-isolation-'))
  const runner = join(process.cwd(), 'scripts/test-local-native-terminal.mjs')
  const report = { browser: plan.browser, headless: plan.headless, repetitions: plan.repetitions, fixture,
    identity, runnerSHA256: hash(await readFile(runner)), cases: [] }
  console.log('Isolation artifacts: ' + directory)
  for (const scenario of plan.cases) {
    const env = isolationEnvironment(process.env, plan, scenario, directory)
    console.log('Starting isolation case: ' + scenario.name)
    const started = Date.now()
    let stdout = '', stderr = ''
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [runner], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000 })
      child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-2 * 1024 * 1024); process.stdout.write(bytes) })
      child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2 * 1024 * 1024) })
      let error
      child.once('error', cause => { error = String(cause) })
      child.once('close', (code, signal) => resolve({ code, signal, error }))
    })
    await writeFile(join(directory, scenario.name + '.log'), stdout + stderr)
    let failure
    try { failure = JSON.parse(await readFile(env.NATIVE_TERMINAL_FAILURE_REPORT, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const completedRuns = stdout.split('visible terminal shell, cwd, pipeline, file write, preview refresh').length - 1
    const passed = isolationPassed(result, plan.repetitions, completedRuns)
    report.cases.push({ ...scenario, ...result, passed, elapsedMs: Date.now() - started,
      completedRuns,
      failurePhase: failure?.phase, failureRepetition: failure?.repetition })
    await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report.cases.at(-1)))
  }
  console.log('Isolation summary: ' + join(directory, 'summary.json'))
  // Continue collecting independent cases, but never turn a failed child green.
  if (report.cases.some(result => !result.passed)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
