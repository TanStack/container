(module
  (import "host" "twice" (func $twice (param i32) (result i32)))
  (func (export "answer") (result i32) i32.const 21 call $twice)
)
