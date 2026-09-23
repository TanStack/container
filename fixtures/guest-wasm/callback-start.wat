(module
  (import "host" "start" (func $start))
  (start $start)
  (func (export "answer") (result i32) i32.const 42)
)
