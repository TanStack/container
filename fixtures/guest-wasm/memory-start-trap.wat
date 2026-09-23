(module
  (import "host" "memory" (memory 1 8))
  (data (i32.const 0) "ok")
  (func $start
    i32.const 8 i32.const 99 i32.store
    unreachable)
  (start $start)
)
