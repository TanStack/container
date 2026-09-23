# Browser sandbox alpha launch checklist

This is the only active launch checklist. The alpha is not ready to release.
Earlier status claims and commands are preserved in
[the historical log](reports/alpha-history-2026-09-23.md), not a second release gate.

## Current candidate

`JIhQsM` is the source-bound `0.1.0-alpha.0` publication-format package pair.
It includes the packaging fixes and MIT license. Reproducible tarballs, public
types in both resolution modes, Vite consumer bundling and offline reinstall
with identical deployment bytes pass. Its repeated strict Chromium/Firefox
workflows are running in session `87907`; no browser pass is claimed yet.
Identities and evidence are in [the candidate record](reports/sdk-split-JIhQsM-candidate.md).
Nothing is published or release-approved. Earlier candidates below remain
regression evidence, not approval for this pair.

## Previous candidate evidence

`ai9akL` is the private API 6 split SDK/runtime candidate. It fixes compiler
dependency resolution so npm and pnpm use the pinned direct dependency graph.
Version, input-hash and package-root checks remain enforced. The isolated site's
pnpm installation and public asset setup pass without dependency-version
overrides. A local tarball override only locates the unpublished runtime package.

Fresh npm adoption passes installation, 153-file deployment verification and
Vite bundling. All twelve WASM inputs match the earlier p11JMm staging bytes.
The compatibility checker accepts the explicit API 5-to-6 change and reports no
removed runtime paths, hosting-contract change or profile change. These checks
are not release approval.

Its twelve-run Chromium/Firefox app batch passes, three complete workflows per
app and browser. The strict paired report check passes in
[the API 6 batch report](reports/framework-split-ai9akL-desktop-batch.json).
The isolated TanStack.com matrix stopped at Counter Chromium: SSR, hydration,
server-function and live-edit assertions all passed, but eleven owner-page
analytics requests failed COEP checks. The failed report is retained in
`reports/tanstack-parity-ai9akL/start-counter-chromium.json`. Development analytics
configuration now follows the site's production-only convention without weakening
isolation or filtering errors. The retry in
`reports/tanstack-parity-ai9akL-dev-analytics` passes all eight runs and 34
behavior assertions across Counter, Basic, Streaming and Router SSR in Chromium
and Firefox. All eight reports validate and both servers stopped. Fatal
page/console errors and failed HTTP responses are empty. Firefox Counter and
Streaming each retain two navigation-cancelled client-module requests. This is
an isolated development integration, not production deployment.
Exact identities are in
[the split-package migration record](reports/tanstack-split-package-migration.md).

The frozen private `ai9akL` candidate also passes the strict save/resume batch:
three Vite and three Start cycles in each of Chromium and Firefox, twelve total.
All twelve per-cycle audits pass with byte-exact restore, blocked external
dependency requests during resume, further edits, acknowledged shutdown and
resource cleanup. The [strict evidence report](reports/sdk-split-ai9akL-strict-evidence.json)
binds both package tarballs and each cycle's exact deployment manifest. This does
not accept later source changes or a publication-format rebuild. Safari remains
unverified.

Previous split candidate `MhXC2w` passed all twelve packaged Vite/Start workflows,
three rounds per app in Chromium and Firefox. Its
[paired evidence](reports/framework-split-MhXC2w-desktop-batch.json) does not
accept the newer API 6 candidate. Older all-in-one `p11JMm` passed the
[isolated four-example site matrix](reports/tanstack-four-example-p11JMm-runbook.md),
eight runs and 34 behavior assertions. That is not split-package or production
deployment evidence.

## Five launch gates

All gates apply to the same final release artifacts. Earlier passing packages
provide regression evidence, not transferable approval.

- [ ] **Real apps work.** Packaged Vite and representative TanStack Start apps
  must pass preview, SSR, hydration, server functions and live edits. Previous
  split workflows and the current candidate's repeated batch pass.
  Keep supported versions and known feature limits explicit.
- [ ] **The development loop works.** Load a project, install supported
  dependencies, edit files, run supported scripts and tests, inspect output,
  save, reload the owner and resume in a fresh kernel. Require restored source,
  server data, installed packages and cache bytes, blocked and recorded external
  dependency requests during resume, further edits/interactions, and acknowledged
  shutdown. Frozen private `ai9akL` passes in Chromium and Firefox. Acceptance of
  the final publication-format artifacts is still pending. Offline workspace restore
  does not mean offline hosting or live-process restore.
- [ ] **Desktop browsers work.** Repeat both complete workflows in Chromium,
  Firefox and actual Safari with clear unsupported-capability errors. Current
  Chromium/Firefox repeated workflows pass. Actual Safari acceptance is still open.
  The user deprioritized further Safari comparison work, so it is not the next
  experiment, but no Safari pass is claimed. Playwright WebKit and diagnostic
  runs do not establish actual Safari acceptance. Retained ordinary failure:
  [p11JMm Safari evidence](reports/safari-p11JMm-final-desktop-candidate.json).
- [ ] **Other developers can adopt it.** Ship the standalone public API, types,
  install/hosting docs, working frontend/full-stack examples, MIT project license,
  supplied third-party notices and an honest exact-artifact compatibility matrix.
  Split package examples, npm consumer setup and pnpm site setup work. Complete
  final paired-package acceptance, fresh-source build verification, reproducible
  packing, release review and registry-install verification remain open.
  Compatibility and publication-identity verifiers do not approve private
  candidates or replace workflow acceptance.
- [ ] **TanStack.com uses it.** At least one real interactive production example
  must use the released standalone SDK. First repeat Counter, Basic, Streaming
  and Router SSR against the current paired artifacts in the isolated site.
  Production dependency adoption and deployment remain open. Simple inline
  examples should keep their lightweight path. The original dirty site checkout
  remains untouched.

## Release and licensing

The frozen source extraction now builds all six engines, shell, HTTP/2, TLS,
SDK staging and split packages without copied runtime outputs. Its fresh
consumer installs both packages, prepares 152 verified deployment files and
bundles with Vite. See [the source-build record](reports/source-extraction-2026-09-23.md).
This uses installed pinned toolchains and predates the latest packaging changes;
it is not final source-bound publication or browser acceptance for the new build.

Source now removes installation-path comments from generated compiler workers
while preserving legal notices. Two independent installation directories produce
identical compiler assets in the regression test. The frozen candidates remain
unchanged. Twelve compiler/setup/package-boundary tests pass.

The new private split `nTFTjj`, combining clean-source staging with the current
packaging helpers, passes reproducible packing, Bundler/NodeNext public types,
Vite bundling and offline uninstall/reinstall with identical deployment bytes.
The older `hBp91J` correctly fails the new deployment-identity check. These are
adoption results, not browser acceptance or source-bound release approval.
See [the adoption record](reports/sdk-split-nTFTjj-adoption.md).

The MIT experimental source is published at
[github.com/TanStack/container](https://github.com/TanStack/container).
The initial source commit is `8e0f57bd29978810811fa995df63e9b4d1d63539`.
No npm packages have been published. Source publication does not approve the
alpha or replace exact-package workflow verification.
The latest outside-sandbox npm authentication check returned E401, so npm
authentication is still required before publication.

Both packages remain private. Select a public alpha version, complete the required
prepublication workflow and source/package reviews, publish source and packages, then verify a fresh
registry install and the actual published identities. Keep final tarballs, source
archive, acceptance evidence and external attestations together. Old all-in-one
release commands do not establish that split-package release wiring is complete.

Source follow-ups after `ai9akL` now preserve MIT metadata and the root license
even in private development packages. Split packaging also verifies the source
archive bound by release staging before copying current helpers, with a second
check after bundling. Focused tests pass; these changes are not in `ai9akL`.
An explicit `--publication-candidate` split build now prepares final alpha
metadata before testing. It requires verified provenance and matching MIT
licenses; private builds remain the default. This prepares publishable format,
not release approval. The reviewed release record and final acceptance are still
required. Preview-host setup also retains its typed routes and headers API.

Our project license is MIT. Preserve dependency notices in package and deployment
outputs, and document unresolved upstream attribution questions. This is not a
requirement to petition authors or reproduce an upstream binary byte for byte.
No maintainer inquiry has been sent. Historical details:
[Rolldown notice review](reports/rolldown-rust-notice-review.md).

## Next actions

1. Retain the completed `ai9akL` app batch and exact paired package bindings.
   Its focused workflow pass does not establish byte-exact restore or final
   release approval for later source changes.
2. Retain the completed four-example site matrix and original analytics failure.
   The existing strict Vite/Start consumers are now running with `SDK_RUNTIME_OUTPUT`
   in `test-results/sdk-split-ai9akL-strict`:
   their split migration preserves exact snapshot restoration, offline install
   skipping, acknowledged shutdown and resource cleanup assertions. Fifteen
   routing/evidence tests and TypeScript checking pass; strict browser runs
   are pending. Do not start another heavy browser workload alongside them.
3. Finish split release wiring and final source/consumer verification, then
   replace temporary local tarball references with released dependencies and
   verify a real production example. Keep the unresolved desktop gate visible.

Production hosting still needs a concrete choice. A cross-origin host iframe
alone does not prove Start can run below a non-isolated docs page. Retained tests
isolate the top-level owner too. See the
[production hosting findings](reports/tanstack-production-hosting-gap.md) for
isolated top-level route/origin options and checkpoint implications. Development
analytics gating does not resolve the production topology.

The isolated site's explicit production asset preparation now uses public SDK
APIs, requires configured owner/preview origins and package identities, and emits
bound deployment assets/configuration without activating routes. Three regression
tests pass for options, wrong identities, preserved hosting policy and asset
hashes, and overwrite refusal. This is preparation, not production deployment.

Build: [BUILDING.md](BUILDING.md). Public setup:
[SDK package guide](src/sdk/PACKAGES.md). Publication verification:
[split attestation guide](scripts/sdk-split-publication-attestation.md).

## Scope and protections

Target common JavaScript and TypeScript projects, not complete Node or operating
system compatibility. Phones, native addons, arbitrary binaries and uncommon
framework features are outside the alpha gate.

Continue ordinary functional work on owned fixtures and public packages:
installation, cancellation, worker lifecycle, filesystem persistence, Node API
behavior, framework builds, previews and save/resume. Preserve permission checks,
isolation boundaries, resource limits, cancellation, accounting and warnings.
Do not extend deadlines, remove resume caches, serialize app operations or
silently substitute dependencies to make a test pass.

Security research, sandbox escapes, exploit development and adversarial probes
are deferred. Functional tests do not prove safe execution of arbitrary hostile
code. If a test is blocked, document what is unverified and move to an independent
functional requirement, do not disguise the same experiment.

Run one heavy browser workload at a time. After two experiments that do not
change the implementation decision, choose a different approach. Every
experiment must produce a fix, an architectural decision or a documented limit.
