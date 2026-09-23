# Astro WASI fixture

Install with `npm ci --cpu=wasm32 --ignore-scripts` in this directory.

Astro compiler binding 0.4.0 needs the version-1 emnapi API. Its runtime accepts
both version-1 and version-2 peers, but sharing Rolldown's version-2 alpha peers
causes a native Node link failure for `env.napi_set_last_error`.
This fixture supplies pinned stable version-1 peers in a separate dependency
tree. Native Node must load it successfully before the browser test runs.
It does not modify or replace the compiler package's source.
