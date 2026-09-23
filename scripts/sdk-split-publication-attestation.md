# Split publication verification

`createSplitSDKPublicationAttestation` in `sdk-split-publication-attestation.mjs` verifies a publication after registry metadata is fetched. It does not publish, fetch metadata, approve a release, or replace workflow acceptance. The old single-package verifier is unchanged.

Pass `sdk` and `runtime`, each with `directory`, `tarball`, and the actual registry packument as `registryMetadata`. Pass an HTTPS `registry`, explicit `distTag`, `sourceArchive`, `acceptanceRecord`, `expectedAcceptanceSHA256`, and `deploymentDirectory`.

`expectedAcceptanceSHA256` must come from independently reviewed release acceptance evidence, not from the candidate being verified. This function checks its byte binding, not the meaning or sufficiency of that evidence. The caller remains responsible for the existing browser, app, adoption, and integration release gates.

Pass `releaseRecord` with exactly these fields:

```js
{
  format: 1,
  status: 'approved-split-candidate',
  source: {
    kind: 'source-archive',
    revision: 'sha256:<archive hash>',
    archive: { file: '<archive basename>', bytes: 123, sha256: '<hash>' },
  },
  packages: {
    sdk: { name, version, private: false, license: 'MIT', publishAccess: 'public', manifestSHA256, tarballSHA256 },
    runtime: { name, version, private: false, license: 'MIT', publishAccess: 'public', manifestSHA256, tarballSHA256 },
  },
  acceptanceSHA256: '<reviewed acceptance hash>',
  deploymentManifestSHA256: '<reviewed deployment manifest hash>',
}
```

Package names are fixed to the two experimental TanStack packages. Versions must match and be alpha versions. The SDK must depend on the exact runtime version. Each directory must be a clean package directory without `node_modules`. The verifier checks all package manifest files, exact tarball contents, registry identities, dependency metadata, dist-tags, SHA-512 integrity, source bytes, and deployed file bytes. Links and unexpected files fail verification.

The deployment hash binds the prepared deployment selected by release review. Its runtime package binding must match the runtime being published. This does not claim that every possible future dependency installation has identical output.

Both packages must include a root `LICENSE` whose bytes match the single regular `web-container-source/LICENSE` entry in the hash-bound source archive. An SPDX field alone is not enough. This checks preservation of the project license, not the completeness of upstream attribution.

Keep release records and attestations outside package directories to avoid circular hashes. Existing private packaging candidates intentionally cannot pass this verifier.
