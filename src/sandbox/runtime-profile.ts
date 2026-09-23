// Compatibility target for version-gated Node tooling, not a Node binary version
// or a claim that every API in that Node release is implemented. Browser/wasm
// platform identity stays explicit and unsupported APIs continue to fail.
// This is the minimum Node release required by the installed Start fixture.
export const nodeCompatibilityVersion='22.12.0'
export const sandboxVersion='0.0.0-spike'
