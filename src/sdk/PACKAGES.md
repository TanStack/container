# Browser sandbox SDK

Experimental and unpublished. Private split-package candidates have passed
repeated Chromium and Firefox workflows. Each release package pair still needs
its own acceptance, including the current source-bound alpha candidate. Actual
Safari remains unverified. Do not transfer results between package candidates.

The browser SDK depends on a matching runtime-support package. Upstream compiler
packages are ordinary pinned npm dependencies, not copied WASM files in our npm
tarballs. Our custom engines and browser workers remain in runtime support.

There are two separate steps:

- npm installs the upstream compiler packages as dependencies.
- Your app's build prepares worker scripts and WASM at URLs the browser can load.

The second step creates deployment assets, not another copy inside our SDK
package. Browsers cannot load files directly from your installed node_modules.

## Prepare assets

After installing the SDK, run this explicitly in your application's build or
setup step. There is no postinstall hook and setup does not download packages.

```js
import { prepareRuntimeAssets } from '@tanstack/browser-sandbox-experimental/assets'

// public must already exist. sandbox must not exist, including as a symlink.
const assets = await prepareRuntimeAssets('public/sandbox')
console.log(assets.runtimeDirectory)
```

Setup bundles the installed compiler adapters for browser workers, copies their
WASM unchanged, preserves available notices, and writes a deployment manifest
with hashes. It refuses mismatched pinned inputs or existing output. Failed
setup can leave partial output for inspection, it never deletes existing files.
Use a fresh build output directory for each build.

Pass the hosted runtime URL explicitly:

```js
import { WorkerKernel } from '@tanstack/browser-sandbox-experimental'

const kernel = new WorkerKernel({}, {
  assetBaseURL: new URL('/sandbox/runtime/', location.origin).href,
})
```

Host the generated kernel host and runtime on the trusted owner origin. Deploy
the generated `preview-host` directory on a separate preview origin, following
its `hosting.json` routes and headers. Asset setup does not configure your host
or weaken the preview isolation requirements. See `COMPATIBILITY.md` for runtime
limits, but its older artifact results do not verify these new packages.

The old synchronous `copyRuntimeAssets` helper is replaced by asynchronous
`prepareRuntimeAssets`. Moving compiler code out of the npm tarball does not
remove the need to preserve notices in the browser deployment.
