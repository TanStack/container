# Compiler WASI fixture

Install with `npm ci --cpu=wasm32 --ignore-scripts` from this directory.
The platform-specific packages are optional dependencies, matching their
upstream packaging. The test collector requires both packages to be present,
so a skipped install is a setup failure, never a passing test.

This is separate from the native workload fixture. It tests the exact WASI
binding versions used by Rolldown 1.2.8 and Astro's compiler binding 0.4.0.
Loading a binding is only the first gate, not a successful framework build.
