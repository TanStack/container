import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'

const requested = process.argv[2]
assert.ok(requested, 'Pass a prepared temporary Node control directory')
assert.ok(!(await lstat(requested)).isSymbolicLink())
const directory = await realpath(requested)
assert.ok(/^\/private\/tmp\/native-node-control-[A-Za-z0-9]+$/.test(directory))
const origin = process.env.NATIVE_NODE_CONTROL_ORIGIN
assert.ok(origin, 'Pass the confirmed task-owned Vite URL as NATIVE_NODE_CONTROL_ORIGIN')
assert.equal(new URL(origin).hostname, '127.0.0.1')
const route = path.join(directory, 'src/routes/index.tsx')
const original = await readFile(route, 'utf8')
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  if (process.env.NATIVE_BROWSER && process.env.NATIVE_BROWSER !== name) continue
  const browser = await engine.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  const navigations = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  })
  try {
    await writeFile(path.join(directory, 'count.txt'), '0')
    await page.goto(origin, { waitUntil: 'networkidle' })
    await page.getByText('TanStack Router', { exact: true }).waitFor({ timeout: 45000 })
    // An actual mutation proves the SSR document hydrated before file edits.
    await page.getByRole('button', { name: 'Add 1 to 0?' }).click()
    await page.getByRole('button', { name: 'Add 1 to 1?' }).waitFor()
    const before = navigations.length
    await mkdir(path.join(directory, 'work'), { recursive: true })
    await writeFile(path.join(directory, 'work/unrelated.txt'), name)
    await page.waitForTimeout(1500)
    assert.equal(navigations.length, before, name + ': unrelated file caused navigation')
    await writeFile(path.join(directory, 'count.txt'), '41')
    await page.waitForTimeout(1500)
    assert.equal(navigations.length, before, name + ': data file caused navigation')
    await page.getByRole('button', { name: 'Add 1 to 1?' }).waitFor()
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByText('TanStack Router', { exact: true }).waitFor({ timeout: 45000 })
    await page.getByRole('button', { name: 'Add 1 to 41?' }).click()
    await page.getByRole('button', { name: 'Add 1 to 42?' }).waitFor()
    const beforeSource = navigations.length
    await writeFile(route, original.replace('Add 1 to', 'Add one to'))
    await page.getByRole('button', { name: 'Add one to 42?' }).waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: 'Add one to 42?' }).click()
    await page.getByRole('button', { name: 'Add one to 43?' }).waitFor()
    assert.deepEqual(errors, [], name + ': page errors')
    console.log(JSON.stringify({ browser: name, unrelatedFileReload: false,
      dataFileReload: false, explicitReloadReadsData: true,
      sourceUpdated: true, sourceNavigations: navigations.length - beforeSource,
      sourceInteraction: true, pageErrors: errors }))
  } finally {
    await writeFile(route, original)
    await browser.close()
  }
}
