(module
  (import "h\00ost" "c\00all" (func $first (param i32) (result i32)))
  (import "h\00ost" "c\00all" (func $second (param i32) (result i32)))
  (func (export "call") (result i32)
    i32.const 1 call $first i32.const 2 call $second i32.add)
)
