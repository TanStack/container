(module
  (import "host" "check" (func $check (result i32)))
  (func (export "run") (param $remaining i32) (result i32)
    (block $done
      local.get $remaining i32.eqz br_if $done
      (loop $again
        call $check
        if unreachable end
        local.get $remaining i32.const 1 i32.sub local.tee $remaining br_if $again))
    i32.const 42))
