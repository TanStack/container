# Releasing

The release flow follows TanStack AI and Pacer: Changesets creates a
`ci: Version Packages` PR, then GitHub Actions publishes after that PR merges.
The SDK and runtime use a fixed version group. Their tracked manifests live in
`packages/`; `publishConfig.directory` selects generated `dist` packages.
Only alpha versions are supported by the current release build.

## First publish, by the maintainer

Do not enable automatic publishing yet. Commit the release setup to
`TanStack/container`, enable Actions, and run the **Release** workflow manually
on `main`. Manual dispatch builds and tests tarballs, it never publishes.
Download its `first-release-<commit>` artifact and inspect
`release-verification.json`. The build uses pinned toolchains and runs fresh
consumer adoption, twelve strict Chromium/Firefox workflows and repeated shipped
examples. It does not certify Safari or deploy TanStack.com.

From the downloaded tarball directory, publish the runtime first, then the SDK:

```sh
npm publish ./tanstack-browser-sandbox-runtime-experimental-0.1.0-alpha.0.tgz --access public --tag alpha
npm publish ./tanstack-browser-sandbox-experimental-0.1.0-alpha.0.tgz --access public --tag alpha
```

Use the exact filenames and version in the artifact if they have changed. Do not
publish the tracked wrapper directories. Never rebuild or edit the downloaded
tarballs between validation and publishing. Publishing and configuring npm
package settings are maintainer actions, not performed by the setup scripts.

## Enable trusted publishing

For **both** npm packages, add a GitHub Actions trusted publisher in npm settings:

| Setting | Value |
| --- | --- |
| Organization | `TanStack` |
| Repository | `container` |
| Workflow filename | `release.yml` |
| Environment | Leave blank, the workflow does not declare one |

Allow direct publishing. Enable GitHub Actions to create pull requests in the
repository settings, then set the repository Actions variable `RELEASE_ENABLED`
to `true`. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is needed. Do not add a
registry token to `.npmrc`. The workflow uses GitHub-hosted runners and npm
11.12.1, above npm's OIDC minimum of 11.5.1.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Subsequent releases

Use `pnpm changeset`, commit the changeset with the code, and merge its PR.
The release action opens or updates the version PR. Review its versions,
changelogs and lockfiles, then merge. Publishing rebuilds from source, checks
the generated versions against the tracked manifests, verifies package files
and runs adoption/browser tests before `changeset publish --tag alpha`.
The action also creates GitHub releases. Failed builds do not publish.

The initial checkout stays in Changesets alpha prerelease mode. Do not exit
that mode or use `latest` until stable-version support and its release policy
have been deliberately implemented. Both packages must remain the same version.

## Local checks and builds

```sh
corepack pnpm install --frozen-lockfile
pnpm test:release
pnpm changeset status
```

The automated toolchain bootstrap targets fresh Linux x64 runners and refuses
to overwrite existing toolchains or package output. For an existing development
machine, follow [BUILDING.md](BUILDING.md), then run `pnpm release:packages` and
`pnpm release:verify`. Source generation must finish before packaging creates
its archive. These commands prepare and verify packages, they do not publish.

The pnpm lockfile is the CI install lock. The npm lock is retained for existing
source-build tooling and evidence checks; `changeset:version` updates both.
Do not edit frozen candidates or copy old browser acceptance into a new release.
