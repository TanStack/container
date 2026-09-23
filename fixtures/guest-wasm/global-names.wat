(module
  (import "h\00ost" "v\00alue" (global $a (mut i32)))
  (import "h\00ost" "v\00alue" (global $b (mut i32)))
  (export "a" (global $a))
  (export "b" (global $b))
  (func (export "sum") (result i32) (i32.add (global.get $a) (global.get $b)))
)
