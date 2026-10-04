# Current pair site and terminal checks, October 4

The newest private Mac SDK/runtime pair passes two complete four-example site
workflows in each of Chromium, Firefox and Playwright WebKit, six of six.
The original full terminal and production-build matrix also passes all twelve
example/browser cells. Full site TypeScript, header checks and 17 harness
regression checks pass. This is private Mac real-site evidence, not an alpha
release or production adoption.

## Inputs

Private site: `/private/tmp/tanstack-native-site-Ikl6PH`.
Evidence and source-only browser runner:
`/private/tmp/native-site-current-pair-krYhpZ`.
Installed consumer:
`/private/var/folders/41/xlbt3gw14jd2hqhrrg0q_0jh0000gn/T/sdk-split-consumer-sUwMU1/consumer`.

The fixture copies 2755 current tracked regular site files at revision
`7ee717384ca61a31355b138b71e67c3ad342d2ce`, with source hash
`6eae3bb679bcf721f13d0bb4a81e5225f0b4551d281277069bcc0e7d6e1af79a`.
No credentials, persistence, dependency directory or Git history is copied.
The frozen pnpm 11.1.0 install uses the existing lock with lifecycle scripts
disabled. Normal Cloudflare and the unchanged approved private Redact build
remain enabled. The tracked Redact test hook is not production adoption.

The first private server launch let dotenv consume the Vite flags and picked
port 3000. That exact fixture process was stopped before browser acceptance.
An explicit dotenv argument separator starts the intended loopback site on
4588, with separate owner 4587 and preview 4589. Both logs are retained.
The user's existing 4198 server is not restarted or edited.

SDK inventory:
`0090a9dee1daaf0f9cb0f0787c757ac10e37b26c04e6f84e8ae51e2e4e4e39b9`.
Runtime inventory:
`05b39e9c27fa616e4a67b82553870c41a1a02b2efa06705df570c2d2e0ac2780`.
Deployment inventory:
`316376898eede38796bfd1c66076daf774cdbcc7bece14b06d30e70abf04ac03`.
The pair comes from the fresh build in
[compiler startup evidence](native-compiler-bootstrap-2026-10-04.md).

The site runner uses the existing locked official Playwright 1.63.0 packages,
Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6. Its actual dependency lock
hash is `c05613a0f4f320fd623e301a3c6bbdbd654f08522efac78113fd14c75069f2df`,
browser catalog hash
`545d52f8382c391e605562c330e9c1c534a16045898203037a49bb8bd769a946`.
This is separate from the SDK driver's locked Playwright 1.62.1 results.
No browser upgrade is claimed to fix the preceding SDK startup failure.

## Completed checks

Full site TypeScript and five HTTP header checks pass. The four native example
routes use require-corp, simple Store stays credentialless and on its original
lightweight path. All 17 repeat, terminal-matrix and project-input harness
regression checks pass.

The unchanged repeat driver tests Counter click, edit, restart and reload,
Basic SSR, binary assets, deferred server functions, hydration, navigation and
edits, Router Express SSR, post navigation and edits, and both progressive
Streaming buttons. Its strict host error gate stays enabled. All six workflows
pass, each of the 12 stream clicks has early data and reaches number 10,
120 nonempty updates total. This suite does not test production builds or the
expanded terminal workflow.

Repeat receipt:
`/var/folders/41/xlbt3gw14jd2hqhrrg0q_0jh0000gn/T/native-site-streaming-repeats-YlT038/results.json`.

## Completed terminal matrix

The unchanged original matrix runs all four examples in all three browsers,
one full terminal workflow per cell. It checks commands, file/editor sharing,
live preview edits, expected failures, input and EOF, interruption, production
build exit status, resize, reopen and restart. It retains failed cells and
continues later fresh-browser cells. Host page errors are diagnostic only,
not a strict error-free host gate. Original deadlines and assertions remain.

All twelve cells pass, including all twelve declared production builds and
post-build restart checks. The retained matrix process exits zero. This is one
complete matrix, not repeated terminal reliability over many sessions.

Matrix receipt:
`/var/folders/41/xlbt3gw14jd2hqhrrg0q_0jh0000gn/T/native-site-terminal-matrix-elewCd/results.json`.

## Verification and cleanup

`verify-results.mjs` in the evidence directory independently re-reads both
receipts, logs, installed package inventories, deployed files, project inputs,
integration sources and the actual browser runner lock/catalog. It checks all
42 site milestones, twelve stable navigation document IDs, twelve progressive
stream clicks and 120 nonempty updates. Every terminal cell has exactly one
complete matching milestone and its production-build start/settlement records.
Both receipts bind the same package pair, with unchanged inputs throughout.

Repeat receipt SHA-256:
`9ca2dd458664b15104de415d700de3cdb8009b258080b7176836811f6da90aa4`.
Terminal receipt SHA-256:
`1601521bdb407099f223ac1b32a87d6f0bf31300d1a839018ded3698e1900654`.
Independent verification receipt SHA-256:
`6d8cfb6ccc29304ba57b50b4002970efd371d2cfab32fb515ec93403e1c43948`.
The earlier failed full Mac SDK receipt remains byte-identical and failed:
`1e3f6c39cdb9942f64d271d74c7fef9a429eed907e2df3f29e4bfe63ba2762a9`.

After the checks, exact process, working-directory and listener checks identify
only the private owner/preview host and fixture Vite server. Both are stopped,
their retained sessions are terminal and 4587/4588/4589 have no listeners.
Main 4198 still listens with PID 39005. Private Wrangler finishes at 25080 KiB,
mostly its 15508 KiB observability directory. This does not reproduce or explain
the historical hundreds-of-gigabytes incident, whose files were already deleted.
No files are deleted in this turn, and all evidence remains available.

No product-runtime changes, main-site or Redact changes, dependency-folder
replacement, altered defaults, retries, new filters, larger deadlines, commit,
publication, deployment or external message. The Start skill guided use of the
normal site setup and its owning renderer, no adapter was disabled to get a pass.

## Remaining work

Current-source Linux and actual x64 CI, final third-party notices and
publication-format acceptance, the exact SolidJS site's examples, maintainer
first publication and production dogfooding remain open. The preceding
intermittent WebKit failures stay failed and unexplained. No runtime repair,
memory-leak fix, performance improvement, publication or deployment is claimed.
