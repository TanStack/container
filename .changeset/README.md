# Changesets

Run `pnpm changeset` for a package change. Select the SDK or runtime and describe
the user-visible change. They release together because the SDK requires an exact
runtime version.

The release action opens a `ci: Version Packages` PR. Review and merge it to
build, test and publish the next alpha. See [release setup](../RELEASING.md) for
the maintainer's first publish and trusted publisher configuration.
