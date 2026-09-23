// The installed runtime is part of the trusted build, not loaded from guest files.
// esbuild-artifact.ts pins its bytes; package builds must verify that same hash.
import 'esbuild-wasm/wasm_exec.js'
import './browser-compiler.worker'
