(module
  (import "host" "memory" (memory 1 8))
  (import "host" "callback" (func $callback (param i32) (result i32)))
  (export "memory" (memory 0))
  (export "alias" (memory 0))
  (func (export "read") (param i32) (result i32)
    local.get 0 i32.load)
  (func (export "write") (param i32 i32)
    local.get 0 local.get 1 i32.store)
  (func (export "grow") (param i32) (result i32)
    local.get 0 memory.grow)
  (func (export "size") (result i32) memory.size)
  (func (export "call") (param i32) (result i32)
    local.get 0 call $callback
    i32.const 0 i32.load i32.add)
  (func (export "reenter") (param i32) (result i32)
    local.get 0
    if (result i32)
      local.get 0 i32.const 1 i32.sub call $callback
      local.get 0 i32.add
    else
      i32.const 1
    end)
  (func (export "growThenCall") (result i32)
    i32.const 1 memory.grow drop
    i32.const 9 call $callback)
)
