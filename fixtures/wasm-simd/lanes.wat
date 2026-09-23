(module
  (memory (export "memory") 1)
  (func (export "run")
    i32.const 0 i32.const 32768 i16x8.splat i32.const 131071 i16x8.replace_lane 3 v128.store
    i32.const 16 v128.const i32x4 0 -2147483648 2147483647 -1 i32.const -2147483648 i32x4.replace_lane 0 v128.store
    i32.const 32 i64.const -9223372036854775808 i64x2.splat i64.const 9223372036854775807 i64x2.replace_lane 1 v128.store
    i32.const 48 v128.const f32x4 1.5 0 -2.5 3.5 f32.const -0 f32x4.replace_lane 1 v128.store
    i32.const 64 f64.const -0 f64x2.splat f64.const 1.5 f64x2.replace_lane 1 v128.store)
  (func (export "i16_signed") (result i32)
    i32.const 32768 i16x8.splat i16x8.extract_lane_s 7)
  (func (export "i16_unsigned") (result i32)
    i32.const 32768 i16x8.splat i16x8.extract_lane_u 7)
  (func (export "i64_low") (result i64)
    i64.const -9223372036854775808 i64x2.splat i64x2.extract_lane 0)
  (func (export "i64_high") (result i64)
    i64.const -9223372036854775808 i64x2.splat i64.const 9223372036854775807 i64x2.replace_lane 1 i64x2.extract_lane 1)
  (func (export "f32_zero") (result f32)
    v128.const f32x4 1 2 3 4 f32.const -0 f32x4.replace_lane 2 f32x4.extract_lane 2)
  (func (export "f64_zero") (result f64)
    f64.const -0 f64x2.splat f64x2.extract_lane 0)
  (func (export "f64_value") (result f64)
    f64.const -0 f64x2.splat f64.const -2.5 f64x2.replace_lane 1 f64x2.extract_lane 1))
