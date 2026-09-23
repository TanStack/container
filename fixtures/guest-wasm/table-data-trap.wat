(module
  (type $unary (func (param i32) (result i32)))
  (import "host" "callback" (func $callback (type $unary)))
  (import "host" "table" (table 2 8 funcref))
  (memory 1)
  (global $value (mut i32) (i32.const 17))
  (func $value (type $unary)
    local.get 0 call $callback global.get $value i32.add
    i32.const 0 i32.load8_u i32.add)
  (elem (i32.const 0) $value)
  (data (i32.const 0) "\07")
  (data (i32.const 65536) "out of bounds")
  (func $start unreachable)
  (start $start))
