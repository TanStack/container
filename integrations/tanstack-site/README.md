# Local TanStack.com integration

This experiment's retained browser evidence uses the installed QA3oVl SDK
tarball on the real Start counter page. The artifact-bound Chromium run covers
cold install, SSR, hydration, server functions, editor live editing, save, a
real owner-page reload, byte-exact offline resume, resumed interactions and
clean Stop. It is one local integration pass, not repeated browser acceptance
or a production deployment. The site keeps WebContainer as its default. Only
the development flag selects the SDK panel.

From the TanStack.com directory, start the separate preview host:

```sh
node scripts/local-browser-sandbox-preview.mjs
```

In another terminal, start the site:

```sh
VITE_LOCAL_BROWSER_SANDBOX=1 \
SANDBOX_LOCAL_SOURCE=/Users/tannerlinsley/GitHub/router/examples/react/start-counter \
SANDBOX_LOCAL_FIXTURE=/Users/tannerlinsley/GitHub/web-container/fixtures/site-start-counter-portable \
TANSTACK_LOCAL_REPOS_DIR=/Users/tannerlinsley/GitHub \
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4198 --strictPort
```

Open <http://127.0.0.1:4198/start/latest/docs/framework/react/examples/start-counter>.
The panel checks that its selected source matches the local fixture. Dependencies
use the declared portable graph, including the WASM compiler packages. Package
lifecycle scripts remain disabled. Run starts a fresh workspace. Save captures
the edited workspace and server-side state, then closes the runtime. Resume
restores it into a fresh runtime without installing dependencies again.

The app uses its configured virtual port 3000. Port discovery alone is not
readiness: the managed bootstrap also signals after Vite finishes `listen()`.
The separate preview origin is `http://127.0.0.1:4199`, not the app's virtual port.

From this repository:

```sh
node --test integrations/tanstack-site/adapter.test.mjs
SDK_MANIFEST=/path/to/sdk/manifest.json \
SDK_MANIFEST_SHA256=97e09d7479d7736712fe583a38148af7b536e054ed390973cab5234b2bd6417a \
SDK_TARBALL=/path/to/tanstack-browser-sandbox-experimental-0.0.0.tgz \
SDK_TARBALL_SHA256=8fbff813e04949fe05c591e0aefccea3ecd1cf6931315aed4bf074a820fa343f \
node integrations/tanstack-site/check.mjs
```

The unit tests mock the SDK and exercise the actual site's session adapter.
Set `TANSTACK_SITE_ADAPTER` if the site is not a sibling checkout. The browser
check requires both hosts above. It checks the visible panel, hydrated server
functions, editor live updates, save, a real owner-page reload, offline resume,
restored source and server data, and clean stop. It writes the artifact-bound
result to `reports/tanstack-site-QA3oVl-acceptance.json`. Release evidence
remains in `ALPHA.md`.

For the existing WebContainer path, start TanStack.com without the local SDK
flag on port 4200, then run:

```sh
node integrations/tanstack-site/webcontainer-check.mjs
```

This is a same-app compatibility probe. Its dependency graph differs from the
portable SDK graph, so it cannot establish an identical-build speed ranking.

## Deployed acceptance

Production acceptance is a separate, fail-closed mode. It only accepts a public
HTTPS owner and an exact published package and artifact identity. It also keeps
the final deployment URL, isolation response headers, and GitHub Actions run
identity in the JSON report.

```sh
TANSTACK_ACCEPTANCE_MODE=deployed \
TANSTACK_OWNER_URL=https://tanstack.com/start/latest/docs/framework/react/examples/start-counter \
SDK_EXPECTED_PACKAGE_NAME=@tanstack/browser-sandbox-experimental \
SDK_EXPECTED_PACKAGE_VERSION=1.2.3 \
SDK_EXPECTED_PACKAGE_INTEGRITY=sha512-... \
SDK_MANIFEST_SHA256=... \
SDK_TARBALL_SHA256=... \
node integrations/tanstack-site/check.mjs
```

The deployed site must expose the selected package name, version, integrity,
public HTTPS tarball URL, manifest SHA256, and tarball SHA256 through its sandbox
project identity endpoint. Local, private, `file:`, `link:`, and `workspace:`
identities fail before the result can pass. This mode does not deploy or modify
TanStack.com.
