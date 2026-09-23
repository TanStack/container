# Framework workspace example

Copy this folder outside the SDK checkout. Install matching locally built core and runtime tarballs, then start the host:

```sh
SDK_TARBALL=/absolute/path/to/tanstack-browser-sandbox-experimental.tgz
RUNTIME_TARBALL=/absolute/path/to/tanstack-browser-sandbox-runtime-experimental.tgz
npm install "$SDK_TARBALL" "$RUNTIME_TARBALL" --ignore-scripts
npm start
```

Open the printed URL. Choose Vite or TanStack Start, then install and run. The first install needs access to registry.npmjs.org. Edit the displayed source and apply it to exercise Vite's live updates. In Start, try the counter, server call and About link.

Save stops the app and stores the full workspace in IndexedDB. Reload the page and resume to start from those files without reinstalling. The host uses ports 4175 (owner) and 4176 (preview), so saved projects remain available after restarting it. Browser storage can also be cleared or evicted.

Choose different ports with `OWNER_PORT=4275 PREVIEW_PORT=4276 npm start`. Keep the same owner port to recover saved projects. A busy port fails startup instead of silently changing origins. For automation, use `OWNER_PORT=0 PREVIEW_PORT=0 npm start` or `startExample({ownerPort:0,previewPort:0})` for temporary ports.

The host calls `prepareRuntimeAssets` to assemble installed compiler dependencies and runtime assets into a fresh temporary hosting directory. It serves the SDK and preview on separate loopback origins. App execution and compilation happen in browser workers, not the host Node server. The client explicitly opts into the experimental compiler and uses only public SDK imports. Package lifecycle scripts are disabled. These split packages have not completed example browser acceptance yet.

The host reads the installed SDK's manifest and reports its build profile in the output. Default and sync profiles use the sync engines. Experimental fiber profiles explicitly enable `experimentalFibers` and the packaged opt-in Rolldown parser. They require both fiber engine slots and the native parser artifact in the manifest. The native parser avoids running Start's parser stack inside QuickJS, where the supported Start fixture exceeds the guest stack. Start also needs the browser compiler already selected by this client so Vite can optimize concurrent client dependencies reliably. The owner serves COOP `same-origin` and COEP `require-corp`, and the client rejects this profile without cross-origin isolation. Missing assets and unknown profiles fail at host startup, there is no sync-engine fallback or extra guest memory allowance. Selecting the matching engine, parser and compiler does not establish framework compatibility for every experimental profile.

The app process gets a 128 MiB allocation, also inherited by ordinary child processes. Worker threads have a separate 64 MiB ceiling. These allocations leave room to run package scripts alongside the app within the existing 512 MiB aggregate process budget. The owner's ceiling remains 256 MiB for Start and 128 MiB for Vite, and compiler limits are unchanged.

Package script reads the live workspace manifest. Run script applies the editor first, then executes the selected command through the SDK's public `runShell` function. Refresh scripts reloads the choices after manifest changes. Output and exit status appear below the controls. Runs have a 30-second limit, so use the existing preview controls for long-running servers. This is not `npm run`: there are no automatic pre/post hooks or npm environment variables.

Fresh projects add an example-only `test` script without changing dependencies or the pinned fixture files. The Vite test imports `message.js` and checks for nonempty text. The Start test requires the app to be running, requests its home page on virtual port 8521, and checks the HTTP status and server-rendered counter and server-action controls. It does not test hydration or clicking those controls. To see a failure, clear the Vite message or stop the Start app, then run `test`. Restore the message or resume the app and run it again. Older saved projects are restored unchanged and may have no test script.

`projects.json` contains pinned manifests and complete locks from the Vite 7 and Start workflow fixtures. Vite uses Rollup WASM and esbuild WASM overrides. These examples do not claim support for arbitrary package versions, native binaries, esbuild watch/serve, or complete Node compatibility.

Exact release candidate `QfShkO`, package version `0.1.0-alpha.0` and manifest
SHA256 `7d36452f83d9ebdf2d94d9ff5b65ff225b22c6de44751da775dbf03c1c35cc32`,
completed three full Start cold, save and offline-resume cycles in Chromium,
Firefox and Playwright WebKit. It also completed three Vite 7 cold and
offline-resume cycles in each engine. These pinned-example results do not
establish arbitrary framework compatibility or actual Safari support.
Playwright WebKit is not Safari evidence.
