(module
  (memory (export "memory") 1)
  (func (export "run")
    i32.const 0
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i8x16.all_true i32.store
    i32.const 16
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i8x16.bitmask i32.store
    i32.const 32
    v128.const i8x16 -128 -1 1 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i8x16.all_true i32.store
    i32.const 48
    v128.const i8x16 -128 -1 1 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i8x16.bitmask i32.store
    i32.const 64
    v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
    i8x16.all_true i32.store
    i32.const 80
    v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
    i8x16.bitmask i32.store
    i32.const 96
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 0
    i8x16.shl v128.store
    i32.const 112
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 1
    i8x16.shl v128.store
    i32.const 128
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 8
    i8x16.shl v128.store
    i32.const 144
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 9
    i8x16.shl v128.store
    i32.const 160
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const -1
    i8x16.shl v128.store
    i32.const 176
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 0
    i8x16.shr_s v128.store
    i32.const 192
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 1
    i8x16.shr_s v128.store
    i32.const 208
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 8
    i8x16.shr_s v128.store
    i32.const 224
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 9
    i8x16.shr_s v128.store
    i32.const 240
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const -1
    i8x16.shr_s v128.store
    i32.const 256
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 0
    i8x16.shr_u v128.store
    i32.const 272
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 1
    i8x16.shr_u v128.store
    i32.const 288
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 8
    i8x16.shr_u v128.store
    i32.const 304
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const 9
    i8x16.shr_u v128.store
    i32.const 320
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i32.const -1
    i8x16.shr_u v128.store
    i32.const 336
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i16x8.all_true i32.store
    i32.const 352
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i16x8.bitmask i32.store
    i32.const 368
    v128.const i16x8 -32768 -1 1 1 32767 -123 123 2
    i16x8.all_true i32.store
    i32.const 384
    v128.const i16x8 -32768 -1 1 1 32767 -123 123 2
    i16x8.bitmask i32.store
    i32.const 400
    v128.const i16x8 0 0 0 0 0 0 0 0
    i16x8.all_true i32.store
    i32.const 416
    v128.const i16x8 0 0 0 0 0 0 0 0
    i16x8.bitmask i32.store
    i32.const 432
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 0
    i16x8.shl v128.store
    i32.const 448
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 1
    i16x8.shl v128.store
    i32.const 464
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 16
    i16x8.shl v128.store
    i32.const 480
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 17
    i16x8.shl v128.store
    i32.const 496
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const -1
    i16x8.shl v128.store
    i32.const 512
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 0
    i16x8.shr_s v128.store
    i32.const 528
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 1
    i16x8.shr_s v128.store
    i32.const 544
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 16
    i16x8.shr_s v128.store
    i32.const 560
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 17
    i16x8.shr_s v128.store
    i32.const 576
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const -1
    i16x8.shr_s v128.store
    i32.const 592
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 0
    i16x8.shr_u v128.store
    i32.const 608
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 1
    i16x8.shr_u v128.store
    i32.const 624
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 16
    i16x8.shr_u v128.store
    i32.const 640
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const 17
    i16x8.shr_u v128.store
    i32.const 656
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32.const -1
    i16x8.shr_u v128.store
    i32.const 672
    v128.const i32x4 -2147483648 -1 0 123
    i32x4.all_true i32.store
    i32.const 688
    v128.const i32x4 -2147483648 -1 0 123
    i32x4.bitmask i32.store
    i32.const 704
    v128.const i32x4 -2147483648 -1 1 123
    i32x4.all_true i32.store
    i32.const 720
    v128.const i32x4 -2147483648 -1 1 123
    i32x4.bitmask i32.store
    i32.const 736
    v128.const i32x4 0 0 0 0
    i32x4.all_true i32.store
    i32.const 752
    v128.const i32x4 0 0 0 0
    i32x4.bitmask i32.store
    i32.const 768
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 0
    i32x4.shl v128.store
    i32.const 784
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 1
    i32x4.shl v128.store
    i32.const 800
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 32
    i32x4.shl v128.store
    i32.const 816
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 33
    i32x4.shl v128.store
    i32.const 832
    v128.const i32x4 -2147483648 -1 0 123
    i32.const -1
    i32x4.shl v128.store
    i32.const 848
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 0
    i32x4.shr_s v128.store
    i32.const 864
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 1
    i32x4.shr_s v128.store
    i32.const 880
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 32
    i32x4.shr_s v128.store
    i32.const 896
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 33
    i32x4.shr_s v128.store
    i32.const 912
    v128.const i32x4 -2147483648 -1 0 123
    i32.const -1
    i32x4.shr_s v128.store
    i32.const 928
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 0
    i32x4.shr_u v128.store
    i32.const 944
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 1
    i32x4.shr_u v128.store
    i32.const 960
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 32
    i32x4.shr_u v128.store
    i32.const 976
    v128.const i32x4 -2147483648 -1 0 123
    i32.const 33
    i32x4.shr_u v128.store
    i32.const 992
    v128.const i32x4 -2147483648 -1 0 123
    i32.const -1
    i32x4.shr_u v128.store
    i32.const 1008
    v128.const i64x2 -9223372036854775808 123
    i64x2.all_true i32.store
    i32.const 1024
    v128.const i64x2 -9223372036854775808 123
    i64x2.bitmask i32.store
    i32.const 1040
    v128.const i64x2 -9223372036854775808 123
    i64x2.all_true i32.store
    i32.const 1056
    v128.const i64x2 -9223372036854775808 123
    i64x2.bitmask i32.store
    i32.const 1072
    v128.const i64x2 0 0
    i64x2.all_true i32.store
    i32.const 1088
    v128.const i64x2 0 0
    i64x2.bitmask i32.store
    i32.const 1104
    v128.const i64x2 -9223372036854775808 123
    i32.const 0
    i64x2.shl v128.store
    i32.const 1120
    v128.const i64x2 -9223372036854775808 123
    i32.const 1
    i64x2.shl v128.store
    i32.const 1136
    v128.const i64x2 -9223372036854775808 123
    i32.const 64
    i64x2.shl v128.store
    i32.const 1152
    v128.const i64x2 -9223372036854775808 123
    i32.const 65
    i64x2.shl v128.store
    i32.const 1168
    v128.const i64x2 -9223372036854775808 123
    i32.const -1
    i64x2.shl v128.store
    i32.const 1184
    v128.const i64x2 -9223372036854775808 123
    i32.const 0
    i64x2.shr_s v128.store
    i32.const 1200
    v128.const i64x2 -9223372036854775808 123
    i32.const 1
    i64x2.shr_s v128.store
    i32.const 1216
    v128.const i64x2 -9223372036854775808 123
    i32.const 64
    i64x2.shr_s v128.store
    i32.const 1232
    v128.const i64x2 -9223372036854775808 123
    i32.const 65
    i64x2.shr_s v128.store
    i32.const 1248
    v128.const i64x2 -9223372036854775808 123
    i32.const -1
    i64x2.shr_s v128.store
    i32.const 1264
    v128.const i64x2 -9223372036854775808 123
    i32.const 0
    i64x2.shr_u v128.store
    i32.const 1280
    v128.const i64x2 -9223372036854775808 123
    i32.const 1
    i64x2.shr_u v128.store
    i32.const 1296
    v128.const i64x2 -9223372036854775808 123
    i32.const 64
    i64x2.shr_u v128.store
    i32.const 1312
    v128.const i64x2 -9223372036854775808 123
    i32.const 65
    i64x2.shr_u v128.store
    i32.const 1328
    v128.const i64x2 -9223372036854775808 123
    i32.const -1
    i64x2.shr_u v128.store
  ))
