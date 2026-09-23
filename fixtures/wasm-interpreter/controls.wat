(module
  (memory (export "memory") 1 256)
  (global $value (mut i32) (i32.const 0))
  (func (export "answer") (result i32) i32.const 42)
  (func (export "bump") (result i32)
    global.get $value i32.const 1 i32.add global.set $value global.get $value)
  (func (export "grow") (param i32) (result i32) local.get 0 memory.grow)
  (func (export "size") (result i32) memory.size)
  (func (export "read") (param i32) (result i32) local.get 0 i32.load8_u)
  (func (export "fill") (param i32)
    i32.const 0 i32.const 7 local.get 0 memory.fill)
  (func (export "loop") (loop $again br $again))
  (func $recurse (export "recurse") call $recurse)
  (type $void (func))
  (table 1 funcref)
  (elem (i32.const 0) $indirect)
  (func $indirect (export "indirect") i32.const 0 call_indirect (type $void))
  (func $depth (export "depth") (param i32) (result i32)
    local.get 0 i32.eqz
    if (result i32) i32.const 0
    else local.get 0 i32.const 1 i32.sub call $depth i32.const 1 i32.add end)
  (func $tail (export "tail") (param i32) (result i32)
    local.get 0 i32.eqz
    if (result i32) i32.const 42
    else local.get 0 i32.const 1 i32.sub return_call $tail end)
  (func $loopTail (export "loopTail") (loop return_call $loopTail))
  (func (export "oob") (result i32) i32.const 65536 i32.load)
  (func (export "unreachable") unreachable)
)
