(module
  (memory (export "memory") 1)
  (func (export "add_lane") (result i32)
    v128.const i32x4 1 2 3 4
    v128.const i32x4 10 20 30 40
    i32x4.add
    i32x4.extract_lane 2)
  (func (export "multiply_lane") (result i32)
    v128.const i32x4 2 3 4 5
    v128.const i32x4 6 7 8 9
    i32x4.mul
    i32x4.extract_lane 3)
  (func $increment (param v128) (result v128)
    local.get 0
    i32.const 1
    i32x4.splat
    i32x4.add)
  (func (export "local_call") (result i32) (local v128)
    v128.const i32x4 11 21 31 41
    local.set 0
    local.get 0
    call $increment
    local.tee 0
    i32x4.extract_lane 3)
  (func (export "load_store") (param i32 i32)
    local.get 1
    local.get 0
    v128.load
    i32.const 2
    i32x4.splat
    i32x4.add
    v128.store)
  (func (export "float_lane") (result f32)
    f32.const 1.25
    f32x4.splat
    f32.const 2.5
    f32x4.splat
    f32x4.add
    f32x4.extract_lane 1))
