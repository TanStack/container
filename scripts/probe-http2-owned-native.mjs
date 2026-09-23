import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const build = JSON.parse(readFileSync('public/http2-runtime/build.json', 'utf8'))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
for (const [file, expected] of Object.entries(build.hashes)) if (hash(file) !== expected) throw new Error(`Build input changed: ${file}`)
const directory = mkdtempSync(join(tmpdir(), 'http2-owned-native-'))
const args = ['-O1', '-g', '-fsanitize=address', '-fno-omit-frame-pointer', ...build.common, 'fixtures/http2-owned-native.c', ...build.files, '-o', join(directory, 'probe')]
const compile = spawnSync('cc', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
const execution = compile.status === 0 ? spawnSync(join(directory, 'probe'), [], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ASAN_OPTIONS: 'abort_on_error=1' } }) : null
const summary = value => value && ({ status: value.status, signal: value.signal, stdout: value.stdout, stderr: value.stderr, error: String(value.error ?? '') })
const report = { build, directory, args, hashes: Object.fromEntries(['fixtures/http2-owned-native.c', 'scripts/probe-http2-owned-native.mjs'].map(file => [file, hash(file)])), compile: summary(compile), execution: summary(execution) }
writeFileSync('reports/http2-owned-native.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ compile: report.compile, execution: report.execution }, null, 2))
if (compile.status !== 0 || execution?.status !== 0 || execution.stderr) process.exitCode = 1
