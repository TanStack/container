(module
  (memory (export "memory") 1)
  (func (export "run")
    i32.const 0
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.eq v128.store
    i32.const 16
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.ne v128.store
    i32.const 32
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.lt_s v128.store
    i32.const 48
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.lt_u v128.store
    i32.const 64
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.gt_s v128.store
    i32.const 80
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.gt_u v128.store
    i32.const 96
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.le_s v128.store
    i32.const 112
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.le_u v128.store
    i32.const 128
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.ge_s v128.store
    i32.const 144
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 127 1 0 2 -128 -64 63 -2 2 4 3 5 7 6 9 8
    i8x16.ge_u v128.store
    i32.const 160
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.eq v128.store
    i32.const 176
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.ne v128.store
    i32.const 192
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.lt_s v128.store
    i32.const 208
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.lt_u v128.store
    i32.const 224
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.gt_s v128.store
    i32.const 240
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.gt_u v128.store
    i32.const 256
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.le_s v128.store
    i32.const 272
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.le_u v128.store
    i32.const 288
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.ge_s v128.store
    i32.const 304
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 32767 1 0 2 -32768 -123 122 -2
    i16x8.ge_u v128.store
    i32.const 320
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.eq v128.store
    i32.const 336
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.ne v128.store
    i32.const 352
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.lt_s v128.store
    i32.const 368
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.lt_u v128.store
    i32.const 384
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.gt_s v128.store
    i32.const 400
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.gt_u v128.store
    i32.const 416
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.le_s v128.store
    i32.const 432
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.le_u v128.store
    i32.const 448
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.ge_s v128.store
    i32.const 464
    v128.const i32x4 -2147483648 -1 0 123
    v128.const i32x4 2147483647 1 0 122
    i32x4.ge_u v128.store
    i32.const 480
    v128.const i64x2 -9223372036854775808 123
    v128.const i64x2 9223372036854775807 122
    i64x2.eq v128.store
    i32.const 496
    v128.const i64x2 -9223372036854775808 123
    v128.const i64x2 9223372036854775807 122
    i64x2.ne v128.store
    i32.const 512
    v128.const i64x2 -9223372036854775808 123
    v128.const i64x2 9223372036854775807 122
    i64x2.lt_s v128.store
    i32.const 528
    v128.const i64x2 -9223372036854775808 123
    v128.const i64x2 9223372036854775807 122
    i64x2.gt_s v128.store
    i32.const 544
    v128.const i64x2 -9223372036854775808 123
    v128.const i64x2 9223372036854775807 122
    i64x2.le_s v128.store
    i32.const 560
    v128.const i64x2 -9223372036854775808 123
    v128.const i64x2 9223372036854775807 122
    i64x2.ge_s v128.store
    i32.const 576
    v128.const f32x4 nan inf -inf 0
    v128.const f32x4 1 inf inf -0
    f32x4.eq v128.store
    i32.const 592
    v128.const f32x4 nan inf -inf 0
    v128.const f32x4 1 inf inf -0
    f32x4.ne v128.store
    i32.const 608
    v128.const f32x4 nan inf -inf 0
    v128.const f32x4 1 inf inf -0
    f32x4.lt v128.store
    i32.const 624
    v128.const f32x4 nan inf -inf 0
    v128.const f32x4 1 inf inf -0
    f32x4.gt v128.store
    i32.const 640
    v128.const f32x4 nan inf -inf 0
    v128.const f32x4 1 inf inf -0
    f32x4.le v128.store
    i32.const 656
    v128.const f32x4 nan inf -inf 0
    v128.const f32x4 1 inf inf -0
    f32x4.ge v128.store
    i32.const 672
    v128.const f32x4 1.5 -2 0 -0
    v128.const f32x4 2 -3 -0 0
    f32x4.eq v128.store
    i32.const 688
    v128.const f32x4 1.5 -2 0 -0
    v128.const f32x4 2 -3 -0 0
    f32x4.ne v128.store
    i32.const 704
    v128.const f32x4 1.5 -2 0 -0
    v128.const f32x4 2 -3 -0 0
    f32x4.lt v128.store
    i32.const 720
    v128.const f32x4 1.5 -2 0 -0
    v128.const f32x4 2 -3 -0 0
    f32x4.gt v128.store
    i32.const 736
    v128.const f32x4 1.5 -2 0 -0
    v128.const f32x4 2 -3 -0 0
    f32x4.le v128.store
    i32.const 752
    v128.const f32x4 1.5 -2 0 -0
    v128.const f32x4 2 -3 -0 0
    f32x4.ge v128.store
    i32.const 768
    v128.const f64x2 1.5 -2
    v128.const f64x2 2 -3
    f64x2.eq v128.store
    i32.const 784
    v128.const f64x2 1.5 -2
    v128.const f64x2 2 -3
    f64x2.ne v128.store
    i32.const 800
    v128.const f64x2 1.5 -2
    v128.const f64x2 2 -3
    f64x2.lt v128.store
    i32.const 816
    v128.const f64x2 1.5 -2
    v128.const f64x2 2 -3
    f64x2.gt v128.store
    i32.const 832
    v128.const f64x2 1.5 -2
    v128.const f64x2 2 -3
    f64x2.le v128.store
    i32.const 848
    v128.const f64x2 1.5 -2
    v128.const f64x2 2 -3
    f64x2.ge v128.store
    i32.const 864
    v128.const f64x2 0 -0
    v128.const f64x2 -0 0
    f64x2.eq v128.store
    i32.const 880
    v128.const f64x2 0 -0
    v128.const f64x2 -0 0
    f64x2.ne v128.store
    i32.const 896
    v128.const f64x2 0 -0
    v128.const f64x2 -0 0
    f64x2.lt v128.store
    i32.const 912
    v128.const f64x2 0 -0
    v128.const f64x2 -0 0
    f64x2.gt v128.store
    i32.const 928
    v128.const f64x2 0 -0
    v128.const f64x2 -0 0
    f64x2.le v128.store
    i32.const 944
    v128.const f64x2 0 -0
    v128.const f64x2 -0 0
    f64x2.ge v128.store
    i32.const 960
    v128.const f64x2 nan inf
    v128.const f64x2 0 -inf
    f64x2.eq v128.store
    i32.const 976
    v128.const f64x2 nan inf
    v128.const f64x2 0 -inf
    f64x2.ne v128.store
    i32.const 992
    v128.const f64x2 nan inf
    v128.const f64x2 0 -inf
    f64x2.lt v128.store
    i32.const 1008
    v128.const f64x2 nan inf
    v128.const f64x2 0 -inf
    f64x2.gt v128.store
    i32.const 1024
    v128.const f64x2 nan inf
    v128.const f64x2 0 -inf
    f64x2.le v128.store
    i32.const 1040
    v128.const f64x2 nan inf
    v128.const f64x2 0 -inf
    f64x2.ge v128.store
  ))
