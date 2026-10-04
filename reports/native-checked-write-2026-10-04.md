# Linux checked-write result, October 4

The complete Linux ARM64 SDK check now passes, all five pinned examples in
Chromium, Firefox and WebKit, plus all six installed directory/context pairs.
The run uses the original 180-second deadlines, four CPUs, 6 GiB memory,
no extra swap and 1 GiB shared memory. Nothing is published.

## Filesystem change

The [previous install probe](native-install-phases-2026-10-04.md) found 63,716
synchronous filesystem calls taking 16.4 seconds during Solid's 20.7-second
install. Each file write checked destination segments, created parents and
wrote contents through separate worker round trips.

The shared provider now sends one internal checked-write request. The owner
checks current path segments, creates parents and writes through its existing
tracked filesystem endpoint. The local Volume path uses the same helper.
No path-check cache, skipped check, framework-specific branch or dependency
substitution is introduced. The public Node filesystem facade is unchanged.

Tests verify one owner request per write for both filesystem codecs, normalized
paths, binary subviews, modes, overwrite behavior, root and ENOTDIR errors,
parent/file change tracking and clean endpoint release. Local tests verify
current namespace checks on each call and failure propagation. Existing
installer cancellation tests also pass.

This is not a controlled speed benchmark or proof that earlier memory failures
are fixed. It removes measured transport work and the unchanged full gate now
completes. No post-change isolated Solid install timing is claimed.

## Full run

| Engine | Five-example workflow | Result |
| --- | ---: | --- |
| Chromium 151.0.7922.34 | 82.924 seconds | Passed |
| Firefox 153.0 | 127.836 seconds | Passed |
| WebKit 26.5 | 132.057 seconds | Passed |

Every engine runs TanStack Start Counter, Basic and Streaming, TanStack Router
file-based SSR, and Solid Start Counter, with the original development
assertions, including progressive streaming and live edits. Production builds
and restart extensions are not requested by this driver. Both shipped Vite /
Rolldown pairs also pass all 26 directory checks, callback async context and
named exports, with no remaining commands or browser errors.

The run passes 205 release tests, 59 installer tests, 11 site-harness tests and
4 project-input tests. The site-harness tests are source tests, not a live-site
acceptance run. Fresh Go/Rust compiler and runtime builds, private split
packaging, installed consumer adoption, Bundler/NodeNext type resolution,
reinstallation and offline deployment equality pass.

The final attempt reuses the fresh locked Node dependencies from this turn's
first container, with identical root, runtime-832 and Oxide-build lock hashes.
It installs the repaired older codec fixture with strict `npm ci`, then freshly
builds the runtimes and SDK. It is not a second clean install of every dependency.
Node is 24.15.0, npm is 11.12.1, Playwright is the locked 1.62.1 release.

## Test setup repairs and retained failures

The first expanded release run fails three tests because the older codec
fixture is not installed. All CI release-test gates and the local build guide
now install that fixture before running the suite. A regression test checks
the workflow ordering.

The second attempt's strict install rejects the existing fixture lock, it lacks
three peer dependencies. The repaired lock adds only `@emnapi/core`,
`@emnapi/runtime` and `@emnapi/wasi-threads`, keeping every existing entry,
the pinned filesystem codec and its integrity unchanged. No legacy peer flag
or skipped fixture replaces the gate. Both failed attempt logs are retained.

The host's older dependency installation still fails broad TypeScript checks
and an unchanged filesystem-codec test. A same-dependency source comparison
finds 108 baseline TypeScript errors and 106 current errors, with no added
diagnostics. That is not a passing host typecheck. The codec test passes in
the correctly installed Linux release suite. No host dependencies are replaced.

## Verified build and evidence

Private evidence directory: `/private/tmp/native-checked-write-WYLnWL`.
`verify-evidence.mjs` independently checks the frozen archive against both the
retained source and current tree, installed package inventories, deployment
bytes before/after reinstallation, all 15 example cells, six directory pairs,
test runner hashes, fixture lock changes and stopped container limits/state.
The original `check-native-sdk.mjs` is byte-identical to the preceding candidate.
Observation remains disabled in acceptance, no example filter or deadline
change is used. These later documentation updates are outside the tested archive.

- Source archive: `bd76871f20a9cc67adb3a7d8d98ebaf5fa37cb99bf801e57a831cb472494af35`.
- Canonical source tar: `b7666f7738c75bfdd4eb27b6d9b32fe9d14479f87e0ec117905f37077958cf7a`.
- SDK manifest: `0090a9dee1daaf0f9cb0f0787c757ac10e37b26c04e6f84e8ae51e2e4e4e39b9`.
- Runtime manifest: `d75fb2ab646986b26b76c18018bef5c764426cc6148c118c59b6d1cdc14d918f`.
- Deployment manifest: `9c5cb06aa163b0b7d337988373ee82406e906cec7fcc8145ab254cba44d8d6ac`.
- Full SDK receipt: `3db165234cbb2251d015e624328bdb4cbf90446e73b23d8e71aa5244da85b8ed`.
- Verified evidence: `4e73b6016e7e8eb3d4a179ff9108ed5798a9fd0958445f95d280c78b68fda386`.
- Complete run log: `10ceef8712f56adaeee6f27844d487cf753425d0f38d0eddf08594f59b811d80`.

Both Rolldown binaries and the Linux-built Oxide binary match the previous
candidate byte for byte. Their memory ABI is unchanged: 1,001 and 983 starting
pages respectively, shared memory, maximum 65,536 pages. The observed cgroup
peak includes builds and file caches, not browser RSS. The run has no OOM kill,
but its observed memory-limit counter is nonzero, no zero-pressure claim is made.

The successful container exits 0, with no mounts or published ports, and is
retained. Two stopped failed containers from this turn are removed after exact
ID, label, state and mount checks to recover about 1.2 GiB. Their logs, source
archives and dependency image are saved, not every byte of their writable
layers. The dedicated VM is stopped. Main TanStack.com and user port 4198 are
untouched, no site, Redact or upstream changes occur.

## Remaining launch checks

The new runtime pair still needs Mac/full-site acceptance and actual Linux x64
CI. Earlier passing site receipts belong to an older pair. Final publication
artifacts, distribution notices, expanded terminal reliability, exact SolidJS
site coverage and production dogfooding remain open. The missing upstream
notice is unchanged, no new external message is sent. The maintainer retains
first-publish authority and the overall goal remains active.
