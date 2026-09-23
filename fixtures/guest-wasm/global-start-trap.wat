(module
  (import "host" "value" (global $value (mut i32)))
  (func $start (global.set $value (i32.const 91)) unreachable)
  (start $start)
)
