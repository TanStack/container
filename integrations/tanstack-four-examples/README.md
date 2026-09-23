# Four-example runtime acceptance

This suite compares the standalone SDK and StackBlitz WebContainer against the
same four TanStack examples. A green cell means every assertion for that exact
source tree passed in a real browser. Configuration, a successful install, or a
similar fixture does not count as compatibility.

The contract binds:

- the TanStack Router revision and a byte-level tree hash for each example;
- the example's declared install and start commands;
- runtime artifact identity and browser version;
- every source or dependency adaptation;
- app-specific SSR, hydration, server behavior, binary asset, streaming, and
  live-edit assertions.

Run `node scripts/tanstack-four-example-contract.mjs sources --repository
/path/to/router --verify` before a batch. Validate retained reports with `node
scripts/tanstack-four-example-contract.mjs verify REPORT...`. Generate the
comparison with `node scripts/tanstack-four-example-contract.mjs summary
REPORT... --out reports/tanstack-four-example-comparison.json`.

Reports may use only `passed`, `failed`, `unsupported`, or `not-run`. The
validator rejects a `passed` report unless every contracted assertion passed.
An unsupported result must name the concrete limitation. Adaptations are
always visible in the report, so a portable dependency graph cannot be
presented as an unchanged upstream graph.

Once either TanStack.com runtime is serving an example, run its browser checks
with:

```sh
node scripts/run-tanstack-four-example.mjs \
  --runtime sdk \
  --example start-counter \
  --owner-url http://127.0.0.1:4198/start/latest/docs/framework/react/examples/start-counter \
  --browser chromium \
  --source-repository /path/to/router \
  --artifact-json /path/to/sdk-artifact.json \
  --integration-json /path/to/tanstack-integration.json \
  --observed-commands-json /path/to/observed-commands.json \
  --adaptations-json /path/to/adaptations.json \
  --out reports/sdk-start-counter.json
```

The runner uses the application behavior, not a runtime diagnostic endpoint.
It also requires the initial marker in the preview document response before it
records SSR as passed. Runtime startup remains the responsibility of the
integration under test, which keeps the same browser assertions reusable for
both implementations.

`integration-json` names the TanStack.com repository revision and every adapter
file with its SHA-256. `observed-commands-json` records the commands the adapter
actually launched and must equal the contract. Each adaptation must bind an
added or changed file with before/after hashes, or an added package with its
exact version. An empty adaptations array means the runtime used the upstream
tree without dependency or source changes.
