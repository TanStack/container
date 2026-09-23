(module
  (memory (export "memory") 1)
  (func (export "run") (local $a v128) (local $b v128)
    v128.const i8x16 0 15 85 170 255 128 127 1 2 3 4 5 6 7 8 9 local.set $a
    v128.const i8x16 255 240 170 85 15 127 128 16 32 48 64 80 96 112 128 144 local.set $b
    i32.const 0 local.get $a v128.not v128.store
    i32.const 16 local.get $a local.get $b v128.and v128.store
    i32.const 32 local.get $a local.get $b v128.andnot v128.store
    i32.const 48 local.get $a local.get $b v128.or v128.store
    i32.const 64 local.get $a local.get $b v128.xor v128.store
    i32.const 80 local.get $a local.get $b
    v128.const i8x16 85 170 15 240 1 128 127 254 51 204 85 170 15 240 0 255
    v128.bitselect v128.store
    i32.const 96 local.get $a local.get $b
    i8x16.shuffle 0 16 1 17 2 18 3 19 12 28 13 29 14 30 15 31 v128.store
    i32.const 112 local.get $a
    v128.const i8x16 15 0 7 16 31 128 255 8 1 2 3 4 5 6 14 13
    i8x16.swizzle v128.store
    i32.const 128 i32.const 130 i8x16.splat i32.const 511 i8x16.replace_lane 3 v128.store)
  (func (export "signed") (result i32)
    v128.const i8x16 0 1 2 3 4 128 6 7 8 9 10 11 12 13 14 15 i8x16.extract_lane_s 5)
  (func (export "unsigned") (result i32)
    v128.const i8x16 0 1 2 3 4 128 6 7 8 9 10 11 12 13 14 15 i8x16.extract_lane_u 5)
  (func (export "zero") (result i32) v128.const i32x4 0 0 0 0 v128.any_true)
  (func (export "nonzero") (result i32) v128.const i32x4 0 0 0 -2147483648 v128.any_true))
