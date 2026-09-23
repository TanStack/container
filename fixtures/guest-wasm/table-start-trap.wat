(module
  (import "host" "table" (table $t 2 8 funcref))
  (func $value (param i32) (result i32) local.get 0 i32.const 1 i32.add)
  (elem (i32.const 0) $value)
  (func $start unreachable)
  (start $start))
