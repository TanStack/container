# Native SvelteKit compatibility fixture

This small app checks whether the browser-owned runtime can start an installed
SvelteKit and Vite toolchain, render a server-loaded value, and reload it after
an SDK file write. Its dependency versions are pinned in `package.json` and
`package-lock.json`.

Build the native browser runtime, then run the browser probe with
`NATIVE_VITE8_BUNDLE_DIR=<runtime-directory> node scripts/probe-native-sveltekit-browser.mjs`.
Set `NATIVE_TEST_BROWSER=firefox` or `webkit` for the other desktop engines.
Set `NATIVE_SVELTEKIT_BUILD=1` to build the client and server production
artifacts inside the browser runtime instead of running the dev-server probe.
Set `NATIVE_SVELTEKIT_PREVIEW=1` to mount the SDK preview bridge and check
hydration, the counter click, a live component edit, and the HMR connection.
Set both flags to check the browser-built production server, its client assets,
hydration, and the counter click in the preview.
Build a full local SDK staging tree with `SDK_NATIVE_RUNTIME_ROOT=<runtime-directory>
node scripts/build-sdk.mjs`, then set `NATIVE_SDK_OUTPUT=<sdk-output>` and
`NATIVE_SVELTEKIT_BUILD_COMMAND=1` to test the normal `npm run build` terminal
path. The probe preserves the installed fixture's `.bin` symlinks in its
browser workspace snapshot.
Set `NATIVE_SVELTEKIT_DEV_COMMAND=1` with the same SDK assets to run `npm run
dev` in the browser terminal, check its server response and live edit, then
interrupt it and check that its virtual port closes.
The probe mounts the complete installed package closure; run `npm ci` in this
fixture first if `node_modules` is absent.

This fixture currently proves a dev-server SSR response, a changed SSR
response, client hydration and component HMR in the SDK preview, and a
browser-owned production build whose generated server serves HTML and client
assets and hydrates in the SDK preview. With the full SDK assets, the normal
terminal `npm run build` also produces client and server artifacts in Chromium,
Firefox, and WebKit. The terminal `npm run dev` path serves the app, observes
an SDK file edit, and stops on interrupt in all three engines. Its SDK preview
also hydrates, responds to a click, and hot reloads a component edit in all
three. Vite's startup tsconfig reload can cancel the first navigation's module
imports in Firefox and WebKit; the probe reports those canceled requests
separately after verifying the replacement page is interactive.
Repeated WebKit runs also exposed an intermittent startup reset or a canceled
navigation that never hydrates. The terminal-started preview is not yet a
reliable first-load gate.
The Vite command now publishes its port only after the actual server starts,
not during its temporary port-availability check. Six consecutive WebKit
first-load probes, plus Firefox and Chromium probes, passed after this fix.
