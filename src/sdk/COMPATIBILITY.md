# Workflow compatibility

This is an experimental alpha with bounded results. The package's
`candidate-compatibility.json` is
the authoritative matrix for its exact `manifest.json`. It records Chromium,
Firefox, actual Safari and Playwright WebKit separately, with cold and resumed
Vite and TanStack Start results. `release-record.json` binds that matrix to the
manifest and source archive. A passed cell means the referenced repeated
workflow evidence was audited for that exact artifact. An unverified cell means
the package makes no compatibility claim for it.

The Vite workflow covers a pinned Vite 7 app with registry installation,
negative and positive tests, interactive preview, state-preserving HMR, save,
owner reload and byte-exact offline resume. The Start workflow covers the
shipped pinned TanStack Start app with SSR, hydration, a POST server function,
navigation, route live edit, save, owner reload and offline resume. These are
representative workflows, not claims that every Vite plugin, Start feature or
Node package works. Playwright WebKit evidence never substitutes for actual
Safari evidence. Phones are outside the alpha requirements.

## Project and runtime boundaries

`examples/frameworks/projects.json` ships complete pinned locks. Both packaged
examples use Vite 7.3.6, Rollup WASM 4.63.1 and esbuild WASM 0.28.2. The Start
example uses `@tanstack/react-start` 1.168.25 and Lightning CSS WASM 1.33.0.
The separate real Start/Vite 8 counter test is not that packaged example.
Installed dependencies alone do not establish that their APIs or CLI work.

The framework example explicitly enables the compiler worker and selects the
engine matching the artifact's build profile. Fiber profiles require
cross-origin isolation. See the example README for hosting and memory limits.
There is no automatic substitution of unsupported native packages.

The public project-command helpers translate declared npm, pnpm, yarn and bun
install/run commands onto the SDK installer and shell. Package run commands
honor pre/post hooks and npm lifecycle environment variables without claiming
that a package-manager binary exists in the guest. The framework example
installs with `ignoreScripts: true`, disabling install lifecycle scripts. Its
test scripts are small workflow checks, not proof of
complete Vitest compatibility. Long-running app processes use preview controls,
not the example's bounded script runner.

Snapshots preserve workspace files, installed dependencies and saved app data,
not running processes, in-memory state or browser sessions. Resume starts a
fresh runtime. Offline dependency resume still needs the host and runtime
assets; it does not mean offline hosting. Browser storage can be evicted.

Native addons, arbitrary native binaries and complete Node compatibility are
not supported. The compiler backend does not support esbuild watch/serve.
Keep existing permissions and resource limits enabled. This experiment is not
a production security boundary for arbitrary hostile projects, and should not
contain sensitive projects or credentials.

## Recorded candidate evidence

These paths identify records in the source repository, not files shipped in
the SDK. The package's own `candidate-compatibility.json` remains the authority
for a downloaded artifact.

- **p11JMm**, unpublished package version `0.0.0`, manifest SHA256
  `8608d7e16abb9b1788d8d5d5b1009e2231a9385533410041115be0c8bc009c06`:
  three packaged Vite and three Start workflows pass in each of Chromium and
  Firefox. The stricter consumers separately pass three cold/offline-resume
  cycles per app and browser, including byte-exact restoration and awaited
  shutdown. The candidate auditor validates
  `reports/sdk-p11JMm-desktop-strict-evidence.json`. The four TanStack examples
  pass all eight isolated integration runs and 34 behavior assertions, with
  declared portable dependency adaptations and request cancellations retained
  in `reports/tanstack-four-example-p11JMm-runbook.md`. These results bind tarball
  `f72b812cc1fccf5711832e7b286073150623a0c50660b9b7198711b1158bec31`.
  Actual Safari, distribution clearance, publication and production integration
  remain incomplete. This source-document update does not modify the frozen
  package or retroactively change its compatibility matrix.

- **xIvIoB**, unpublished package version `0.0.0`, manifest SHA256
  `cc2c3029634d5c632590a0ca95cea1b55cd2823e86c0b4c24051f15ee7abb38e`:
  three packaged Vite and Start workflows pass in each of Chromium and Firefox.
  Records are in `test-results/sdk-xIvIoB-chromium-repeated` and
  `test-results/sdk-xIvIoB-firefox-repeated`. The four exact TanStack examples
  also have eight passing browser runs and 34 passing behavior assertions,
  selected in `reports/tanstack-four-example-xIvIoB-runbook.md`. An initial
  Start Basic Firefox run failed while another browser workload was running;
  its unchanged sequential rerun passed. Both records are retained. These
  results use tarball SHA256
  `315ae1b549d535763bc7203a0f8ac0f08ead81a58522782faad31690967a1ab7`.
  Actual Safari acceptance is incomplete. See
  `reports/safari-xIvIoB-follow-up.md` for partial passes, the screen-lock
  confound and an unresolved intermittent install stall. This source document
  does not retroactively update the packaged compatibility matrix.

- **QfShkO**, package version `0.1.0-alpha.0`, manifest SHA256
  `7d36452f83d9ebdf2d94d9ff5b65ff225b22c6de44751da775dbf03c1c35cc32`:
  three Vite and Start cold/save/offline-resume cycles in Chromium, Firefox and
  Playwright WebKit are bound by
  `reports/sdk-6hJUoV-compatibility-evidence.json`. The underlying records are
  in `test-results/sdk-alpha-6hJUoV-vite` and
  `test-results/sdk-alpha-6hJUoV-desktop`. The real TanStack.com integration is
  in `reports/tanstack-site-QfShkO-final-acceptance.json`. These records bind
  tarball SHA256
  `8db6f134112f0dc2856452f9fa77efeb3979f2a2f6f0b81af68e25d00a6c9e0b`.
  Actual Safari remains unverified for this artifact.
