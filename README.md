# TanStack Container

An experimental browser-powered sandbox for frontend and full-stack JavaScript
development. Projects run in the browser using a virtual filesystem, JavaScript
processes, supported package installation, app previews and saved workspaces.

The [source is available on GitHub](https://github.com/TanStack/container) under
the MIT license. The npm alpha release is being prepared. No npm packages have
been published yet.

## What works

The tested workflows cover Vite 7 and representative TanStack Start apps:
installation, script and test execution, live edits, previews, SSR, hydration,
server functions, navigation, and save/reload/resume. Private split-package
candidates have passed repeated Chromium and Firefox runs. The source-bound
alpha package pair is undergoing its own verification. Actual Safari remains
unverified. Earlier candidate results do not approve later package builds.

This is not a complete Node.js or operating-system implementation. Native addons,
arbitrary binaries, dependency install scripts and unrestricted networking are
outside the supported alpha scope. Phones are a stretch goal. Offline workspace
resume does not mean offline hosting or restoring a running process.

## Use the SDK

The SDK is standalone, with no TanStack.com-specific runtime code:

- `@tanstack/browser-sandbox-experimental` provides the public API and types.
- `@tanstack/browser-sandbox-runtime-experimental` supplies the matching custom
  engines and workers, with upstream compilers as pinned npm dependencies.
- Your app explicitly prepares and hosts browser assets. There is no automatic
  postinstall download.

Start with the [SDK setup guide](src/sdk/PACKAGES.md) and
[compatibility boundaries](src/sdk/COMPATIBILITY.md). The
[basic example](examples/sdk-basic/README.md) and
[Vite/Start examples](examples/sdk-frameworks/README.md) demonstrate adoption.
Until publication, build the package pair using [BUILDING.md](BUILDING.md).

Full TanStack Start environments require an isolated owner document with the
documented headers and a separate preview origin. Lightweight inline examples
do not need to adopt the full runtime.

## Build and contribute

[BUILDING.md](BUILDING.md) lists the pinned toolchains, runtime generation,
package build and consumer checks. [ALPHA.md](ALPHA.md) is the active release
checklist. Its local evidence links may refer to reports that are not included
in a source snapshot; they are not shipped acceptance evidence.

## Isolation limits

This is not a production security boundary for arbitrary hostile projects.
Do not use sensitive source or credentials in an untrusted sandbox. Explicit
permissions, quotas, deadlines and owner-controlled networking are implemented,
but functional compatibility tests are not a security certification.

See [LICENSE](LICENSE) for the project license. Dependency notices are preserved
in package and prepared deployment outputs.
