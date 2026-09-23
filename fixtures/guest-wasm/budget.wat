(module
  (func (export "finite") (param $remaining i32) (result i32)
    (loop $again
      local.get $remaining i32.const 1 i32.sub local.tee $remaining br_if $again)
    i32.const 42)
  (func (export "loop") (loop $again br $again))
  (func (export "answer") (result i32) i32.const 42)
)
