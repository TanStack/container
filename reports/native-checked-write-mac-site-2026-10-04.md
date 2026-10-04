# Checked-write Mac and site checks, October 4

The new private packages pass all four TanStack.com examples in every desktop
engine. The fresh Mac SDK driver passes Chromium and Firefox, but WebKit fails
an owner control before reaching the examples. A separate same-pair WebKit run
with phase logging passes that control and all five examples. The original
failure remains unexplained and its receipt stays failed.

## Compatibility fix

An optional-method check could mistake a generic RPC proxy's synthesized
function for declared support for `writeFileWithParentsSync`. A new test
reproduces the failure on the preceding implementation. The installer now
requires the operation to be declared and callable before selecting it.
Otherwise it uses the existing checked-write helper through public operations.
Real shared providers still use one owner request per write. No path checks,
modes, error handling or namespace behavior are removed.

All 60 installer tests pass, including binary contents, modes, namespace checks,
the new proxy case and existing cancellation coverage. The new regression runs
in the existing source-checks CI job. No new interface or framework exception
is added. This source change is newer than the preceding passing Linux receipt,
that receipt does not transfer to these runtime bytes.

## Fresh Mac build

A new source extraction installs all four committed npm locks with lifecycle
scripts disabled, Node 24.15.0 and npm 11.12.1. All 205 release tests, 60 installer
tests, 11 site-harness tests and four project-input tests pass. Official Go
1.27.1 for Darwin ARM64 is downloaded and checked against its official metadata,
Rust 1.95.0 and the existing WASI target are verified, then runtime and package
outputs are built from source. No prior runtime outputs are copied.

Private split packaging, installed consumer adoption, Bundler/NodeNext types,
repeat packs, offline reinstallation and deployment equality pass. The public
SDK manifest is unchanged, the runtime and deployment manifests are new.
These are private `0.0.0` packages, not an approved alpha.

The unchanged complete SDK driver uses locked Playwright 1.62.1, Chromium
151.0.7922.34, Firefox 153.0 and WebKit 26.5. Chromium completes all five examples
in 68.116 seconds, Firefox in 97.435 seconds. WebKit fails after 34.892 seconds
during the retained-output control. Its command exits 1 because a native worker
reaches the original 30-second startup timeout at `rolldown-loading`, not
because output was observed buffering or exceeding its budget. No WebKit
example runs in that original batch. The full receipt remains failed at
`desktop SDK acceptance`, no deadline or assertion is changed.

The separate installed directory control passes all six browser/toolchain
pairs on that same locked runner, 26 checks each, callback async context and
named exports, with no remaining commands or browser errors. Its first input
record was observed in the tool output, the remaining raw results are saved
in `directory-results.log`. Independent verification checks all six rows and
the observed source, workload and runner-lock hashes.

## Real TanStack.com fixture

The isolated fixture copies the current site's tracked files, without Git
metadata, credentials, local environment files or persistence. Its base source
hash matches the previous fixture. Only the existing dev-only integration for
the four full-environment routes is selected. Lightweight examples keep their
existing path. The main site and user-facing port 4198 are untouched.

The fixture installs its own frozen pnpm lock and keeps the normal Cloudflare
and Redact setup. Full site TypeScript checking passes. All four native routes
use `require-corp`; the simple Store route still uses `credentialless`.
The approved private Redact recovery build is unchanged, its source and emitted
hydration module match their reviewed hashes. Production must consume that
owning fix through the normal dependency path, this local hook is not deployment.

The strict four-example driver and error filter remain unchanged. The same
external official Playwright 1.63.0 runner used for the previous site checks
runs one complete workflow per engine, not repeated reliability acceptance.
It uses Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6. This is separate
from the older locked runner used by the failed SDK batch.

| Engine | Full site workflow | First ReadableStream output | First async-generator output |
| --- | ---: | ---: | ---: |
| Chromium | 66.606 seconds | 926 ms | 629 ms |
| Firefox | 83.787 seconds | 1,249 ms | 628 ms |
| WebKit | 87.308 seconds | 1,035 ms | 1,557 ms |

Each workflow passes Counter mutation/edit/restart/reload, Basic SSR/binary
assets/deferred server functions/navigation/edit, Router Express SSR/post
navigation/edit, and both progressive streams. All 21 milestone lines occur
exactly once, both navigation document IDs are preserved, and all 60 nonempty
stream updates progress from one through ten numbers. These are whole workflow
times, not controlled startup or installation benchmarks. The original
15-minute child deadlines and strict host error gate are unchanged.

## WebKit diagnosis

After the site workflow, a separate diagnostic uses the same installed packages,
locked Playwright 1.62.1 and WebKit 26.5, original five examples, assertions and
180-second deadline. Only the existing owner phase logging is enabled. Both
output controls and all five examples pass in 83.611 seconds. Package and
deployment identities match before and after.

This shows that the failure is intermittent, not that logging fixes it, that
the newer browser fixes it, or that any memory leak or startup race is solved.
No further identical rerun is used to promote a green result over the failure.
Next isolate the native command worker's compiler bootstrap and lifecycle,
keeping the ordinary commands and startup limits intact.

## Evidence

Private build and diagnosis directory: `/private/tmp/native-mac-checked-write-EXigDb`.
Consumer: `/private/var/folders/41/xlbt3gw14jd2hqhrrg0q_0jh0000gn/T/sdk-split-consumer-2QPun0/consumer`.
Site fixture: `/private/tmp/tanstack-native-site-YQbeuR`.
Site receipt: `/var/folders/41/xlbt3gw14jd2hqhrrg0q_0jh0000gn/T/native-site-streaming-repeats-wTsvAE/results.json`.

`verify-evidence.mjs` recomputes the canonical source archive against the frozen
and current trees, installed inventories, deployment and reinstall equality,
completed SDK engines, retained failure, directory rows, all site milestones,
navigation IDs, stream observations and actual runner identities. It checks
the diagnostic against that same pair. Later status documentation is outside
the frozen source archive. Full site TypeScript exits zero in retained session
18870, it is separate from the SDK's consumer type checks.

- Source archive: `abaa0589fd9947944d03a501cc83c431228fcbc5efa0fe5d40bf41405696eec7`.
- Canonical tar: `3f5d6b2d8530649ab04157b5ac974053e961cf69557dbc29c13504517de34cf8`.
- SDK manifest: `0090a9dee1daaf0f9cb0f0787c757ac10e37b26c04e6f84e8ae51e2e4e4e39b9`.
- Runtime manifest: `5392b285f19aa26955a537de03f5291f2626c1e54b04e69d8833df8440f75483`.
- Deployment manifest: `f2c261e7f724201c9db7baa8a3dfd67cf0f55943694b0d2fe3824cde5bed32d0`.
- Failed full SDK receipt: `1e3f6c39cdb9942f64d271d74c7fef9a429eed907e2df3f29e4bfe63ba2762a9`.
- Passing site receipt: `b65697f0ad34b9f5787ef353273e7539855f48ff9b203de7af3810760fdb15a6`.
- Independent evidence: `a45470e3415bf6600cb0ffe69f4206e9908962ec4d1cad911a3acbdbf4f8ef13`.

Both private hosts are stopped after exact command, working-directory and
listener checks. Retained sessions confirm exit and ports 4587, 4588 and 4589
are empty. No files are removed. Private Wrangler storage is about 19.5 MiB,
not an explanation of the older deleted huge directory. The Linux VM stays
stopped. No commits, publication, deployment or new external messages occur.

The existing upstream notice issue is still open with zero comments at readback.
The unexplained WebKit bootstrap failure, repeated new-pair site reliability,
new-source Linux checks, actual x64 CI, terminal reliability, final distribution
review, maintainer publication, exact SolidJS site coverage and production
dogfooding remain open. The overall goal stays active.
