(module
  (import "host" "callback" (func $callback (param i32) (result i32)))
  (memory (export "memory") 1 8)
  (func (export "call") (param i32) (result i32)
    local.get 0 call $callback local.get 0 i32.add)
  (func (export "reenter") (param i32) (result i32)
    local.get 0
    if (result i32)
      local.get 0 i32.const 1 i32.sub call $callback local.get 0 i32.add
    else
      i32.const 1
    end)
  (func (export "growThenCall") (result i32)
    i32.const 1 memory.grow drop i32.const 3 call $callback)
  (func (export "readAfterCall") (result i32)
    i32.const 5 call $callback drop i32.const 65536 i32.load8_u)
  (func (export "trap") unreachable)
)
