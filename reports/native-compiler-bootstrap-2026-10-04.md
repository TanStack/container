# Compiler startup boundaries, October 4

The fresh Mac native SDK build passes the complete expanded desktop driver.
The new startup metadata works with both shipped compiler versions. This
does not explain or repair the earlier intermittent WebKit bootstrap timeout,
whose failed receipt remains byte-identical and failed.

## Runtime change

The native bootstrap installs a progress reporter only while importing the
browser compiler. The pinned loader reports its existing fetch, body-read,
WASI initialization and binding-ready boundaries. Small event listeners report
each compiler worker's creation, readiness or load failure. They do not consume
or change the original messages and release themselves on load or failure.
Reporter exceptions cannot replace compiler results or errors. Reporting uses
the existing native progress transport, not process stdout or stderr.

`scripts/compiler-bootstrap-progress.mjs` adds metadata only at exact original
source anchors. Missing, duplicate and already transformed anchors fail the
build. Both pinned compiler versions restore to their original loader source
byte for byte after removing the inserted import, counter and metadata calls.
Six unit checks also cover reporter cleanup, original error-event delivery
and ignored unrelated worker messages. These checks join `test:release`.

No altered await expressions, promise handlers, compiler pool, startup deadline,
WASM bytes, memory ABI, cleanup algorithm, retries or fallback. The original
30-second command startup timeout retains the last received progress phase.
This is diagnostic improvement, not a speculative cancellation fix.

## Fresh source and build

Private directory: `/private/tmp/native-compiler-bootstrap-6Qoe33`.
Frozen root: `web-container-source` inside that directory.
Node 24.15.0, npm 11.12.1, macOS ARM64. All four locked npm installations run
with lifecycle scripts disabled: root, second runtime, owned Oxide build inputs
and older filesystem codec fixture. No changes to the main checkout's mixed
dependency installation.

Source gzip SHA-256:
`87f784af14e825abdbfd3b5a3da4cd99c8bf2a522b76d0b286d7c73e020499f5`.
Tar SHA-256:
`512afef3b53d0c301c94e50acb1ec9c984abfed5f1869c880ca7e823089a3fb4`.
2257 files, 4775395 compressed bytes.

All 212 release, 60 installer, 11 site-harness and four project-input checks
pass. Official Go metadata identifies the downloaded Darwin ARM64 Go 1.27.1
archive, whose SHA-256 verifies as
`ee215d57e0ec269c60cc9ceca68e6bda321ba9ee5afe24f4b0988703c2d87d12`.
Rust 1.95.0, commit `59807616e1fa2540724bfbac14d7976d7e4a3860`, has the
required `wasm32-wasip1-threads` target. The shell and owned Oxide compile from
source, then both pinned runtimes and the native-only SDK build.

Private consumer:
`/private/var/folders/41/xlbt3gw14jd2hqhrrg0q_0jh0000gn/T/sdk-split-consumer-sUwMU1/consumer`.
Bundler and NodeNext type resolution, native consumer bundling, repeat packs,
offline reinstall and exact deployment equality pass. Packages remain private
`0.0.0`, API 8. No publication-format alpha is created.

SDK manifest, unchanged:
`0090a9dee1daaf0f9cb0f0787c757ac10e37b26c04e6f84e8ae51e2e4e4e39b9`.
New runtime manifest:
`05b39e9c27fa616e4a67b82553870c41a1a02b2efa06705df570c2d2e0ac2780`.
New deployment manifest:
`316376898eede38796bfd1c66076daf774cdbcc7bece14b06d30e70abf04ac03`.
SDK tarball, unchanged:
`3fde7994f976a40a2c7a6eceba6c095217bfc5f6f400a58399e63c65e319c747`.
New runtime tarball:
`9f2a2b0f750da9392eb5fab1917854da0648b9946209674c790a627121e72da3`.

Both new engine hashes:

- Vite 8.3.1 / Rolldown 1.2.11:
  `c69c59d1bbcc4e7fa7514e074ccc39d7cc452ec3bf4406b95126201092e84734`.
- Vite 8.3.2 / Rolldown 1.2.12:
  `38560d534edbda89fad6b2065101dd689d486088ed98ba2ea598f44b197551ca`.

The new JavaScript bytes require their own acceptance. No earlier Linux or
site receipt transfers to this pair. The sole full-text notice gap remains
`napi-wasm@1.1.3`, no distribution approval is claimed.

## Complete installed SDK check

`run-mac-check.mjs` invokes the current unchanged-default
`scripts/check-native-sdk.mjs` after the fresh build setup. Session 1845 exits
zero, no signal. One complete original five-example owner/terminal/agent test
per engine passes with the locked official Playwright 1.62.1 runner:

- Chromium 151.0.7922.34, 68.827 seconds.
- Firefox 153.0, 96.535 seconds.
- WebKit 26.5, 85.687 seconds.

The full examples remain Counter, Basic, Streaming, Router file-based SSR and
Solid Start Counter. Development, live edits and the existing progressive
stream checks pass. This run does not request production builds or broader
SolidJS site coverage.

The installed directory/context control passes all six engine/toolchain pairs,
26 checks each, callback context, named exports and zero active commands. The
new command lifecycle control passes all six pairs, four completion-or-stop
and replacement sequences per pair, 48 ordinary Node runs and no browser
errors or active commands left. The complete private driver includes these
checks, this is not a derived merge of separate diagnostic runs.

Original 180-second per-engine SDK limit and all existing assertions stay
unchanged. The build driver clears inherited experimental settings. No
test filter, per-phase console observer, larger memory budget, forced
collection, example reset, retry or reduced fixture suite.

## Independent verification

`verify-evidence.mjs` verifies frozen and current source against the archive,
installed SDK/runtime inventories and deployed assets against the full passed
receipt, every acceptance helper and the actual browser lock. Each of the
48 command workers reports all five inserted boundaries once in order and
all eight compiler workers ready before binding readiness. It checks the
complete stage observations, not just the test's passed flag.

All 11 deployed WASM files are identical to the preceding Mac pair. Both
compiler memory records remain identical, Rolldown 1001 and Oxide 983 starting
pages, shared memory, maximum 65536 pages. Owned Oxide SHA-256 remains
`271f3040d8ddfba265741b0cf20efec552e06adc48214402b8ac770c3c8b006b`.
The two runtime inventories record both new startup helper sources and have
no experimental diagnostics profile.

Passed full receipt SHA-256:
`5121a495aead635d6576156068f685879c17730af609e76d31c788bd8f5a7aed`.
Verified evidence SHA-256:
`e6d5f8faa46e46671bfc2e2259ece37e63adde33701285b5dd2b1b2d7c139274`.
Full build/check log SHA-256:
`b9c36c33fe5baa6d5f67b535cf6c2817f42ab92ad015c9f2ae54c1edc035721c`.
Terminal state receipt SHA-256:
`2a2d8183d437c144e77937579c95ab4ec51227b007defb5ede1b3f8df3411212`.
Earlier failed full Mac receipt, unchanged:
`1e3f6c39cdb9942f64d271d74c7fef9a429eed907e2df3f29e4bfe63ba2762a9`.

This verification precedes later BUILDING, ALPHA, goal and report documentation
changes. Operational source matches the tested archive. A passing run does
not prove the earlier failure's cause or a performance improvement.

## Remaining work

Next run this exact pair through repeated real-site and terminal workflows,
then current-source Linux and actual x64 CI checks. Final notice review,
publication-format alpha acceptance, exact SolidJS site coverage, maintainer
first publication and production dogfooding remain required. The goal is active.

All private test processes finish and their own hosts close. Main site port
4198 still listens with PID 39005. No main-site/Redact change, dependency-folder
replacement, file deletion, commit, publication, deploy or external message.
