(module
  (import "env" "pause" (func $pause))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    i32.const 0
    i32.const 41
    i32.store
    call $pause
    i32.const 0
    i32.load
    i32.const 1
    i32.add))
