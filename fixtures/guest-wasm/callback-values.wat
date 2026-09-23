(module
  (import "host" "value" (func $value (param i32 i64 f32 f64) (result i32 i64 f32 f64)))
  (func (export "call") (result i32 i64 f32 f64)
    i32.const -7 i64.const 9007199254740993 f32.const 1.25 f64.const 2.5 call $value)
)
