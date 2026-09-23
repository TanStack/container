#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// For rust-lld, configure the rustup launcher too: toolchain library paths
// need to be established at the final native-tool launch, not through Node.
// Set this executable as CARGO_TARGET_WASM32_WASIP1_THREADS_LINKER.
export function captureLink(args, env = process.env) {
  const linker = env.LINK_EVIDENCE_LINKER
  const root = env.LINK_EVIDENCE_DIRECTORY
  if (!linker || !isAbsolute(linker) || !statSync(linker).isFile()) {
    throw new Error('LINK_EVIDENCE_LINKER must name an absolute linker file')
  }
  if (!root || !isAbsolute(root) || !statSync(root).isDirectory()) {
    throw new Error('LINK_EVIDENCE_DIRECTORY must name an existing absolute directory')
  }
  const executable = realpathSync(linker)
  if (executable === realpathSync(fileURLToPath(import.meta.url))) {
    throw new Error('The evidence wrapper cannot be its own linker')
  }
  const rustup = env.LINK_EVIDENCE_RUSTUP
  const toolchain = env.LINK_EVIDENCE_TOOLCHAIN
  let launcher = null
  if (rustup || toolchain) {
    if (!rustup || !isAbsolute(rustup) || !statSync(rustup).isFile() || !toolchain || !/^[a-zA-Z0-9_.-]+$/.test(toolchain)) {
      throw new Error('Configure an absolute LINK_EVIDENCE_RUSTUP and explicit LINK_EVIDENCE_TOOLCHAIN together')
    }
    if (!env.RUSTUP_HOME || !isAbsolute(env.RUSTUP_HOME) || !statSync(env.RUSTUP_HOME).isDirectory()) {
      throw new Error('The rustup launcher requires an explicit existing RUSTUP_HOME')
    }
    launcher = { path: realpathSync(rustup), toolchain, rustupHome: realpathSync(env.RUSTUP_HOME),
      sha256: createHash('sha256').update(readFileSync(rustup)).digest('hex') }
  }
  const directory = mkdtempSync(join(realpathSync(root), 'link-'))
  const addedArgs = ['--Map=' + join(directory, 'link.map'),
    '--reproduce=' + join(directory, 'reproduce.tar'),
    '--why-extract=' + join(directory, 'why-extract.txt')]
  const flavorArgs = args[0] === '-flavor' ? [] : ['-flavor', 'wasm']
  const record = {
    cwd: process.cwd(), linker: executable,
    linkerSHA256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    originalArgs: args, flavorArgs, addedArgs, launcher, startedAt: new Date().toISOString(),
  }
  const recordPath = join(directory, 'invocation.json')
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
  // rust-lld needs an explicit flavor because this wrapper changes argv[0].
  const nativeArgs = [...flavorArgs, ...args, ...addedArgs]
  const result = spawnSync(launcher?.path ?? executable, launcher ? ['run', toolchain, executable, ...nativeArgs] : nativeArgs, {
    env, stdio: 'inherit',
  })
  Object.assign(record, {
    finishedAt: new Date().toISOString(), status: result.status, signal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
  })
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
  return { status: result.status ?? 1, signal: result.signal, directory }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    const result = captureLink(process.argv.slice(2))
    if (result.signal) process.kill(process.pid, result.signal)
    else process.exitCode = result.status
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
