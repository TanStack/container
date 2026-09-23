(module
  (memory (export "memory") 1)
  (func (export "run")
    i32.const 0
    i32.const 1000 v128.load8x8_s offset=3 align=1 v128.store
    i32.const 16
    i32.const 1000 v128.load8x8_u offset=3 align=1 v128.store
    i32.const 32
    i32.const 1000 v128.load16x4_s offset=3 align=1 v128.store
    i32.const 48
    i32.const 1000 v128.load16x4_u offset=3 align=1 v128.store
    i32.const 64
    i32.const 1000 v128.load32x2_s offset=3 align=1 v128.store
    i32.const 80
    i32.const 1000 v128.load32x2_u offset=3 align=1 v128.store
    i32.const 96
    i32.const 1000 v128.load8_splat offset=3 align=1 v128.store
    i32.const 112
    i32.const 1000 v128.load16_splat offset=3 align=1 v128.store
    i32.const 128
    i32.const 1000 v128.load32_splat offset=3 align=1 v128.store
    i32.const 144
    i32.const 1000 v128.load64_splat offset=3 align=1 v128.store
    i32.const 160
    i32.const 1000 v128.load32_zero offset=3 align=1 v128.store
    i32.const 176
    i32.const 1000 v128.load64_zero offset=3 align=1 v128.store
    i32.const 192
    i32.const 1000 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load8_lane offset=3 align=1 15 v128.store
    i32.const 208
    i32.const 1000 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load16_lane offset=3 align=1 7 v128.store
    i32.const 224
    i32.const 1000 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load32_lane offset=3 align=1 3 v128.store
    i32.const 240
    i32.const 1000 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load64_lane offset=3 align=1 1 v128.store
    i32.const 2256 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.store8_lane offset=3 align=1 15
    i32.const 2272 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.store16_lane offset=3 align=1 7
    i32.const 2288 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.store32_lane offset=3 align=1 3
    i32.const 2304 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.store64_lane offset=3 align=1 1
    i32.const 320
    i32.const 65535 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load8_lane 0 v128.store
    i32.const 336
    i32.const 65534 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load16_lane 0 v128.store
    i32.const 352
    i32.const 65532 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load32_lane 0 v128.store
    i32.const 368
    i32.const 65528 v128.const i8x16 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 v128.load64_lane 0 v128.store
  ))
