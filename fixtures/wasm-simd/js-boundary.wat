(module
  (import "env" "callback" (func $callback (result v128)))
  (export "callback" (func $callback))
  (func (export "argument") (param v128))
  (func (export "result") (result v128) unreachable)
  (func (export "ordinary") (result i32) i32.const 42))
