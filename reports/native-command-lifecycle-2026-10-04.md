# Ordinary Node command lifecycle, October 4

The current Mac SDK pair passes the small command replacement control in
Chromium, Firefox and WebKit with both shipped compiler versions. This does
not reproduce or explain the intermittent full WebKit startup failure.
That original failed receipt remains failed and byte-identical.

## Control and decision

`tests/native-command-lifecycle-sdk.test.mjs` uses the installed SDK, its
separate-origin owner frame and a small local project without dependencies.
Per browser/compiler pair it runs four sequences, alternating natural
completion and ready-confirmed cancellation, then starts a replacement Node
command. Each replacement must return the expected output and exit zero,
every completed sequence must leave zero active commands. Cancellation must
be acknowledged and retain its AbortError. The test checks browser errors,
installed package identities, its own source and the locked browser runner.

All six pairs pass, 48 Node command runs, 12 ready-confirmed cancellations,
24 replacement commands. Existing progress messages are buffered in the host,
not printed while the sequence runs. No worker constructor proxy or changed
runtime bytes, no retries, sleeps between commands, forced collection, larger
deadline, pool change or fallback. The original 30-second worker startup
deadline stays unchanged.

The logged phases show every command worker initializes Rolldown, including
simple output-only commands. This is an architecture observation, not proof
that eager compiler loading or cancellation caused the previous timeout.
The small control also lacks the earlier full owner's larger workspace and
complete preceding workload, so it cannot establish broad startup reliability.

Next observe compiler download, WASM initialization and worker-pool readiness
separately. Do not rewrite cancellation or waive the existing failure based
on this result. No identical full gate was repeated in this turn.

## Installed inputs and process results

Private evidence directory: `/private/tmp/native-command-lifecycle-EercOi`.
The three independent browser processes use the previous frozen Mac source
root and its official locked Playwright 1.62.1 installation. The control itself
is the new current-workspace test, not a file from that earlier source archive.

SDK manifest:
`0090a9dee1daaf0f9cb0f0787c757ac10e37b26c04e6f84e8ae51e2e4e4e39b9`.
Runtime manifest:
`5392b285f19aa26955a537de03f5291f2626c1e54b04e69d8833df8440f75483`.
Deployment manifest:
`f2c261e7f724201c9db7baa8a3dfd67cf0f55943694b0d2fe3824cde5bed32d0`.
Control source:
`0661c0a007b0178e08b1ec112f27a66f7c3fcd728e3a527c3a905b6efa0fb434`.
Browser runner lock:
`64a769550c30d66c6a3da355c47ab1ce4b440f0b5dda7c3704edd7022edff5c0`.

All processes exit zero without a signal:

- WebKit 26.5, session 66394, 9.3 seconds.
- Chromium 151.0.7922.34, session 97829, 7.8 seconds.
- Firefox 153.0, session 8439, 13.4 seconds.

`verify.mjs` verifies each terminal receipt and full log hash, each engine's
two results, all eight Rolldown-ready command worker identities per pair,
unchanged installed/deployment inventories, browser lock and source helpers.
It verifies operational runtime sources against the frozen source, and the
original failed Mac receipt against its previous hash. It merges the three
verified diagnostic logs into derived input for the strict all-pairs parser,
that merged input is not represented as a single full CI process.

`verified.json` SHA-256:
`5ce2ba1fac3fa87fc66ba051ed889e0f8409a87eaabf642354e204136648a212`.
Original full Mac receipt SHA-256:
`1e3f6c39cdb9942f64d271d74c7fef9a429eed907e2df3f29e4bfe63ba2762a9`.

## Automation and source checks

`scripts/check-native-sdk.mjs` now runs this control after the existing full
example and directory checks. It requires all six browser/compiler pairs,
all four sequences per pair, successful replacement status, zero active
commands, no browser errors and matching package and browser-runner identities.
One new driver regression checks rejection of omissions, duplicate pairs,
missing cancellation, bad statuses, active commands and invalid timings.
All seven driver checks pass. The original full example assertions and
deadlines are unchanged. No new full build of this expanded driver is claimed.

The broader local release run fails at the root-directory codec control.
The focused reproduction is retained at `local-codec.log`, terminal exit one.
Installed direct fs-core is 4.68.1, while installed memfs and its nested fs-core
are 4.70.0. Both lockfiles require direct fs-core 4.70.0. The old direct package
is a real directory, not the normal pnpm link. This is a mixed installed tree,
not evidence of the same defect in the fresh packaged browser build.

`pnpm install --frozen-lockfile --offline --ignore-scripts` stops with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. No forced replacement or manual
node_modules edit follows. The existing dependency folder is left alone.

A new source copy at `/private/tmp/native-command-source-3rDYMb` uses ordinary
locked offline npm installs for the root, the older filesystem codec fixture
and the second runtime fixture. Its direct/nested fs-core and memfs all report
4.70.0. All 206 release checks pass, session 92368, exit zero. A separate
24 worker/Rolldown cleanup checks pass. The workspace's first 24 cleanup
checks also passed despite the distinct codec failure.

Fresh source gzip SHA-256:
`cd5a53a264317b5ba54d982d1fd861912b477fa1b115594148b7765bff49f55e`.
Tar SHA-256:
`d724aadb53b423b19dcbfde36737302b5dc0ca94e6dc3284e9be488859c73299`.
2253 files, 4771457 compressed bytes. The current source matches this tested
archive before later BUILDING, ALPHA, goal and report documentation changes.
Source-test receipt SHA-256:
`35d296d3c0a3b1fdaa4c68ebd9f8a13e7426109f0a021f0590669c2682aaf97e`.
Full passing source-test log SHA-256:
`ed77d8a8a7416e8e57c26dfa2dd0b38a5e4d8fcede4675599a68c3c5b5ab9704`.

## Scope left open

No product runtime change, failure waiver or release approval. New complete
Mac/Linux/x64 checks, repeated site/terminal reliability, remaining notices,
exact SolidJS site coverage, maintainer publication and production dogfooding
remain open. The goal stays active.

All browser control processes are terminal and their own HTTP hosts close in
finally blocks. Main site port 4198 still listens with PID 39005, read-only
check. No site/Redact mutation, private file removal, historic Wrangler cause
claim, commit, publish, deploy or upstream message.
