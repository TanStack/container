# Current Linux build and CI checkpoint, October 4

The fresh Linux ARM64 build succeeds, but its complete SDK acceptance fails.
Chromium and Firefox each pass all five examples. WebKit passes Counter, Basic
and Streaming, then Router SSR does not open port 3000 within the original
30-second readiness deadline. Solid and the later directory/context and command
lifecycle gates are not reached. The failed container exits 1 and is retained.

The build uses source archive SHA-256
`15bc56ea9ea5aafc2718e17eaf4a4788c5c921817fb1f28604fbdafd603ffde1`,
fresh locked npm inputs, Node 24.15.0, Go 1.27.1 and Rust 1.95.0. All 212 release,
60 installer, 11 harness and four input checks pass before the browser gate.
Fresh native runtime builds, private split packaging, consumer bundling and
type checks, reproducible packing and offline reinstall checks also pass.

## Separate diagnostic

A new container using the same installed pair passes all five WebKit examples
in 134.3 seconds with startup and module tracing enabled. Its peak cgroup memory
is 3,670,421,504 bytes. Its final memory-limit and OOM event counters are zero.
The failed full check and this diagnostic both use four CPUs, a 6 GiB container
memory limit, no extra swap and 1 GiB shared memory. Only the dedicated VM disk
is expanded, from 32 to 64 GiB, to retain fresh build inputs and evidence.

This is not a runtime repair or a replacement for the failed gate. Module
tracing adds a promise continuation to imports, so its passing result cannot
establish that the untraced startup timing problem is fixed. The original
deadlines and assertions remain unchanged.

Installed Linux identities:

- SDK: `0090a9dee1daaf0f9cb0f0787c757ac10e37b26c04e6f84e8ae51e2e4e4e39b9`
- Runtime: `23babbc4a11d2414066da1c867a84a4a156710ff67f187c83f2beaea358c10fb`
- Deployment: `5b6f7002525e95e1566ce8680a0463abdf7c5f47aa792e8de3382f6a52ef1793`

The JavaScript engine bytes match the tested Mac pair. Platform-specific Rust
compiler output differs. Mac site and terminal results do not transfer to these
Linux runtime bytes.

## Checkpoint branch

The maintainer approved a reviewed source checkpoint branch for Linux x64 CI,
not publication or a change to main. The branch starts from upstream commit
`0be9a9edea6a7dd3bf8ed45229fd694e7698ffff`. It preserves that commit's fixture
dependency updates and npm lock-conflict regression fixture. Native source,
tests and the read-only private SDK workflow are added from the current source
snapshot. The root npm lockfile is reconciled and the pnpm lockfile is regenerated
to match the preserved upstream dependency versions.

The branch excludes local caches, generated runtime assets, package tarballs,
raw test logs, the internal goal journal and generated Astro metadata. Release
automation cannot run on this branch. Its merged source has its own identity
and requires its own CI result, earlier package passes do not approve it.

Full alpha acceptance, repeated terminal reliability, the remaining upstream
notice issue and production dogfooding stay open. Nothing is published.
