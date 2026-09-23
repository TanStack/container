# Building the SDK from source

## Package layout and build order

Follow sections 1 through 4 in order for the selected native UTF-8 Buffer alpha
profile. `build-sdk.mjs` produces a verified internal staging tree, then
`build-sdk-packages.mjs` produces the standalone package pair.

The second build produces private `sdk` and `runtime` package candidates and
keeps staging evidence outside them. The SDK depends on the matching runtime
package. Upstream compiler WASM and pthread code are not shipped in either
tarball. `prepareRuntimeAssets` assembles those files from pinned installed npm
dependencies during the consumer's explicit setup step. Our custom engines and
worker code remain in runtime support. See `src/sdk/PACKAGES.md` for usage.

This split has its own package and deployment manifests. Earlier all-in-one
browser reports do not count as acceptance for it. Basic and framework examples
use this layout. No command below publishes a package.

Run these commands from the repository root in a fresh checkout. Build tools run
on the host. Projects loaded into the sandbox run in the browser.

This is the ordered build recipe for the alpha profile. A complete run from a
fresh source archive is still required before release. Existing `public/`
assets are build outputs, not evidence that this recipe has completed.

## 1. Dependencies and toolchains

Install the locked host dependencies and the two fixture dependency sets used
by the build:

```sh
npm ci
npm ci --prefix fixtures/workloads --ignore-scripts
npm ci --prefix tests/fixtures/rolldown-native-probe --ignore-scripts
```

Follow [the pinned QuickJS and Emscripten setup](patches/README.md#build),
including the wasm3 checkout. The expected inputs are:

| Input | Version or revision | Location |
| --- | --- | --- |
| quickjs-emscripten | `df4efb9ef2cb25c417ecb57986da462d11b244ed` | `.toolchains/quickjs-emscripten` |
| Emscripten | `5.0.1` | `.toolchains/emsdk/upstream/emscripten/emcc` |
| wasm3 | `5fe766c933c7595d728d6172bb1a197607d85b4e` | `.toolchains/wasm3` |
| Go | `1.27.1` | `.toolchains/go-sdk/go/bin/go` |

Install the Go distribution for your host under `.toolchains/go-sdk/go`, using
the official release checksum to verify the downloaded archive. Populate its
module cache using the committed `shell/mvdan/go.mod` and `go.sum`:

```sh
GOPATH="$PWD/.toolchains/go-sdk/gopath" \
GOCACHE="$PWD/.toolchains/go-sdk/gocache" \
GOTOOLCHAIN=local \
.toolchains/go-sdk/go/bin/go -C shell/mvdan mod download
```

The shell build uses this cache offline and rejects a different Go version.

## 2. Generate all runtime inputs

Build the JavaScript builtins and browser data types:

```sh
node scripts/build-kernel-builtins.mjs
node scripts/build-vm-web-apis.mjs
node scripts/build-mvdan-shell.mjs .toolchains/go-sdk
```

Build the six engines selected by the alpha profile. The long options select
the recorded interpreter and scheduling implementations, so keep them intact:

```sh
node scripts/build-quickjs-als.mjs
node scripts/build-quickjs-als.mjs --wasm
node scripts/build-quickjs-als.mjs --asyncify --opt=O2 --iterative-calls --generator-queue --profile-yields --cooperative
node scripts/build-quickjs-als.mjs --asyncify --wasm --opt=O2 --iterative-calls --generator-queue --profile-yields --wasm-poll=4096 --cooperative --wasm-dispatch-batch=16 --iterative-assignments --dispatch-unwind --heap-loops
node scripts/build-quickjs-als.mjs --asyncify --atomics --fibers --shared-storage
node scripts/build-quickjs-als.mjs --asyncify --wasm --opt=O2 --atomics --segment-interpreter-batched --binaryen-one-caller-inline-max=50 --iterative-assignments --fibers --shared-storage --simd --lazy-wasm --compiled-initializers --iterative-calls --module-import-exports --native-utf8 --native-utf8-buffer
```

Build [HTTP/2 and TLS from their pinned source archives](build-inputs/README.md).
Those instructions include archive hashes, source verification, and explicit
compiler paths. The SDK requires both resulting `public/http2-runtime` and
`public/tls-runtime` directories.

## 3. Finalize source and package

Finish section 2 before creating the source archive. Builtin generation rewrites
included files under `src/compiler/generated/`; an archive created before those
changes will fail source-bound packaging. If rebuilding from an existing archive,
packaging must reverify it against the generated source. Do not bypass a mismatch,
resolve it or create a new archive with a new identity.

For a private development candidate, build the selected profile and then split
the printed staging directory:

```sh
SDK_BUILD_PROFILE=experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter-batched-native-utf8-buffer \
SDK_ROLLDOWN_PARSER_ROOT=tests/fixtures/rolldown-native-probe \
node scripts/build-sdk.mjs
node scripts/build-sdk-packages.mjs /absolute/path/to/printed-staging
```

For a publication candidate, use this alternative packaging sequence after the
same runtime generation. The version is an example, choose the release version
before generating final artifacts. Use a new archive filename outside the source
tree, then keep source unchanged through both packaging commands:

```sh
node scripts/source-snapshot.mjs . /absolute/path/outside/repository/source.tar.gz
SDK_RELEASE=1 \
SDK_RELEASE_VERSION=0.1.0-alpha.0 \
SDK_RELEASE_LICENSE=MIT \
SDK_RELEASE_REPOSITORY_URL=https://github.com/tanstack/container.git \
SDK_SOURCE_ARCHIVE=/absolute/path/outside/repository/source.tar.gz \
SDK_BUILD_PROFILE=experimental-fibers-simd-lazy-initializers-o2-iterative-calls-module-import-exports-assignments-cooperative-heap-loops-segmented-interpreter-batched-native-utf8-buffer \
SDK_ROLLDOWN_PARSER_ROOT=tests/fixtures/rolldown-native-probe \
node scripts/build-sdk.mjs

SDK_SOURCE_ARCHIVE=/absolute/path/outside/repository/source.tar.gz \
node scripts/build-sdk-packages.mjs --publication-candidate /absolute/path/to/printed-staging
```

Staging stays private. The explicit split option writes `private: false` and
`publishConfig: { "access": "public" }` to both final package manifests before
their hashes and acceptance evidence are created. It requires the same verified
source archive, an alpha version, MIT license and HTTPS git repository metadata.
It does not publish or approve a release. `candidate-status.json` records
`packageFormat: "publication-candidate"` and `releaseApproved: false`.
Repository availability, browser acceptance and production integration are not
inferred from metadata. The planned repository URL is not proof it exists.

## 4. Verify the exact package pair

The adoption check packs and installs both packages into a fresh consumer,
assembles and verifies deployment assets, rejects overwriting that deployment,
imports the public SDK and bundles a Vite consumer. It also checks reproducible
tarballs for both packages, public TypeScript resolution with Bundler and
NodeNext, and offline uninstall/reinstall with unchanged package and deployment
bytes. It does not prove browser workflows or registry publication.

```sh
node scripts/test-sdk-packages.mjs /absolute/path/to/package-build-output
```

Run the packaged examples serially with both package paths. Use a fresh report
directory and retain it for the paired evidence check:

```sh
SDK_OUTPUT=/absolute/path/to/package-build-output/sdk \
SDK_RUNTIME_OUTPUT=/absolute/path/to/package-build-output/runtime \
./node_modules/.bin/playwright test tests/sdk/framework-example.spec.mjs \
  --config=playwright.sdk.config.ts --project=chromium --project=firefox \
  --workers=1 --repeat-each=3 --output=/absolute/path/to/new/framework-reports

SDK_RUNTIME_OUTPUT=/absolute/path/to/package-build-output/runtime \
node scripts/check-framework-batch.mjs \
  /absolute/path/to/package-build-output/sdk \
  /absolute/path/to/new/framework-reports chromium,firefox
```

The checker binds both package manifests and tarball identities across the
paired workflow/observation reports, checks paired deployment identities, and
requires three Vite and three Start runs per selected browser. Its result does
not establish actual Safari support, byte-exact restoration or complete release
acceptance. Strict snapshot/resource checks and production integration remain
separate evidence.

Do not mutate packages after acceptance. Test the exact publication-candidate
bytes and create the separate reviewed release record before publication.
A fresh build is a new artifact requiring its own browser acceptance.

`scripts/verify-sdk.mjs`, `scripts/test-sdk-package.mjs` and
`scripts/run-sdk-desktop-acceptance.mjs` still consume the legacy all-in-one
`manifest.json` layout. Do not pass a split SDK directory to them. Their older
checks and results do not substitute for acceptance of the final package pair.

The [release checklist](ALPHA.md#five-launch-gates) also requires the actual browser
workflows, full source-build validation, notices, public source, and publication.
Create the release source archive only after all source changes and generated
source files are final. A reproducible npm tarball alone does not establish
reproducible native binaries or application compatibility.

Source snapshots record both the downloadable gzip SHA-256 and the uncompressed
canonical tar SHA-256. Different Node/zlib versions can compress identical tar
bytes differently. Verification compares the exact canonical tar, including
file metadata and padding, and reports the supplied gzip's actual hash. Pin the
recorded Node/zlib versions when reproducing the compressed bytes themselves.

## Optional guest-function diagnostic

For this separate diagnostic, remove `--native-utf8-buffer` from the sixth
engine command, add `--guest-sampling`, and replace the final `-buffer` in the
package profile with `-guest-sampling`. This creates a
separate diagnostic artifact, not a release candidate or a default engine.
Collection also requires process diagnostics to be enabled.

The sampler records the current function and bytecode position at existing
interpreter branch interrupt polls, at most once every 20 milliseconds. Each
runtime retains its latest 512 samples in a fixed host allocation of at most
172,064 bytes, outside the guest heap quota. Runtime teardown frees it.
Names are copied at collection, then read by the host outside active fibers.

These are branch samples, not a complete CPU profile. Native functions,
straight-line code and time spent waiting are not measured by their sample
counts. Truncated names and missing source metadata are marked explicitly.
Use the results to choose a targeted experiment, not to claim an exact CPU
percentage or browser acceptance. Application deadlines remain unchanged.

## Native Buffer UTF-8 checks

Section 2 already includes `--native-utf8-buffer` and section 3 selects the
matching profile. Do not add a sampling flag to the alpha build.

The operations count without allocating encoded output, write into the existing
byte view, replace lone surrogates with U+FFFD, and stop before a code point that
does not fit. They retain interrupt polling. Engines without the optional
operations keep the JavaScript implementation.

Run the actual-engine checks by setting `NATIVE_UTF8_BUFFER_ENGINE` to the
printed engine output directory and running:

```sh
node --test tests/native-utf8-buffer-engine.test.mjs
```

Without that environment variable, these checks are skipped, not passed.
Passing them does not replace the packaged application/browser acceptance gate.
