These are exact package.json bytes from the published npm packages, kept as
test data so notice checks do not need old compiler installs or host-specific
optional binaries. The notice collector checks each SHA-256 against its pinned
record. These fixtures contain no executable package code.

Sources:

- `@rolldown/binding-wasm32-wasi@1.2.9`, integrity in `../rolldown-native-probe/package-lock.json`.
- `@napi-rs/wasm-runtime@1.2.4`, the dependency of that pinned binding.
- `@tybys/wasm-util@0.10.2`, bundled in the integrity-checked `@tailwindcss/oxide-wasm32-wasi@4.3.3` archive.
