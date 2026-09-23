# Shared WASM worker fixture

Run `node scripts/prepare-shared-wasm.mjs` to assemble the pinned WAT source,
then `node fixtures/shared-wasm/main.mjs` for the native Node control.
The assembler uses the same local pinned toolchain as the existing guest-WASM
fixtures. The generated manifest records source, binary and assembler hashes.

The fixture uses one shared page, growing to two, and a 158-byte module.
It checks atomic load, store and read-modify-write, module and memory transport
through a real worker, a WASM wait woken by its peer, and shared growth with
old views remaining live. The notification loop yields between attempts and
has a deadline, so the handshake does not depend on guessing a startup delay.

Packaged SDK acceptance cases are named `shared WASM workers match native` in
`tests/sdk/static-consumer.spec.ts`. They require a passing native control and
attach both results. They currently fail at shared memory construction, not at
compiler allocation limits. Do not mark them passing by skipping the worker,
copying memory, or treating ordinary memory as shared.
