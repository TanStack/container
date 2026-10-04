# Native Astro compatibility fixture

This is a normal Astro 7.3.5 static page. Its npm lock resolves Vite 8.3.1
and Rolldown 1.2.11. `ASTRO_TELEMETRY_DISABLED=1 npm run build` is the host
control and should render `Astro 42`.

The browser probe mounts the installed dependency graph. npm skips the
`wasm32` optional packages when installing on macOS, so stage Astro's two
published WASI bindings locally for the probe without changing the lock:

```sh
npm install --prefix fixtures/native-astro --ignore-scripts --no-audit --no-fund
npm install --prefix fixtures/native-astro --force --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @astrojs/compiler-binding-wasm32-wasi@0.5.1 @bruits/satteri-wasm32-wasi@0.10.5
NATIVE_RUNTIME_OUTPUT=/private/tmp/astro-native-probe-runtime npm run build:native-runtime
NATIVE_VITE8_BUNDLE_DIR=/private/tmp/astro-native-probe-runtime node scripts/probe-native-astro-browser.mjs
```

The forced optional-package install is probe setup, not a runtime workaround.
The static build and prerender produce `Astro 42` in the browser-owned volume
on Chromium, Firefox, and WebKit. `NATIVE_ASTRO_DEV=1` also starts Astro's
dev server, fetches its page over the virtual HTTP port, changes the source
inside the browser volume, and verifies the next response renders `Astro 43`
in all three desktop engines. This covers the pinned fixture, not integrations
or larger projects. The small
`NATIVE_ASTRO_BASELINE=1` run checks the same browser host and ESM
`createRequire()` path without the Astro graph. Set `NATIVE_TEST_BROWSER` to
`firefox` or `webkit` to run another desktop engine.
