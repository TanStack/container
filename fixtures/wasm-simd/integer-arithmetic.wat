(module
  (memory (export "memory") 1)
  (func (export "run")
    i32.const 0
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    i8x16.abs v128.store
    i32.const 16
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    i8x16.neg v128.store
    i32.const 32
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.add v128.store
    i32.const 48
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.sub v128.store
    i32.const 64
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    i8x16.popcnt v128.store
    i32.const 80
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.add_sat_s v128.store
    i32.const 96
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.add_sat_u v128.store
    i32.const 112
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.sub_sat_s v128.store
    i32.const 128
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.sub_sat_u v128.store
    i32.const 144
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.min_s v128.store
    i32.const 160
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.min_u v128.store
    i32.const 176
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.max_s v128.store
    i32.const 192
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.max_u v128.store
    i32.const 208
    v128.const i8x16 -128 -1 0 1 127 -120 120 64 -64 5 6 7 8 9 10 11
    v128.const i8x16 1 1 0 -1 1 -20 20 64 -65 2 3 4 5 6 7 8
    i8x16.avgr_u v128.store
    i32.const 224
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    i16x8.abs v128.store
    i32.const 240
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    i16x8.neg v128.store
    i32.const 256
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.add v128.store
    i32.const 272
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.sub v128.store
    i32.const 288
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.mul v128.store
    i32.const 304
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.add_sat_s v128.store
    i32.const 320
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.add_sat_u v128.store
    i32.const 336
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.sub_sat_s v128.store
    i32.const 352
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.sub_sat_u v128.store
    i32.const 368
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.min_s v128.store
    i32.const 384
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.min_u v128.store
    i32.const 400
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.max_s v128.store
    i32.const 416
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.max_u v128.store
    i32.const 432
    v128.const i16x8 -32768 -1 0 1 32767 -32760 32760 123
    v128.const i16x8 1 1 0 -1 1 -20 20 2
    i16x8.avgr_u v128.store
    i32.const 448
    v128.const i32x4 -2147483648 -1 2147483647 12345
    i32x4.abs v128.store
    i32.const 464
    v128.const i32x4 -2147483648 -1 2147483647 12345
    i32x4.neg v128.store
    i32.const 480
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 1 2 1 98765
    i32x4.add v128.store
    i32.const 496
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 1 2 1 98765
    i32x4.sub v128.store
    i32.const 512
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 1 2 1 98765
    i32x4.mul v128.store
    i32.const 528
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 1 2 1 98765
    i32x4.min_s v128.store
    i32.const 544
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 1 2 1 98765
    i32x4.min_u v128.store
    i32.const 560
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 1 2 1 98765
    i32x4.max_s v128.store
    i32.const 576
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 1 2 1 98765
    i32x4.max_u v128.store
    i32.const 592
    v128.const i64x2 -9223372036854775808 9223372036854775807
    i64x2.abs v128.store
    i32.const 608
    v128.const i64x2 -9223372036854775808 9223372036854775807
    i64x2.neg v128.store
    i32.const 624
    v128.const i64x2 -9223372036854775808 9223372036854775807
    v128.const i64x2 -1 3
    i64x2.add v128.store
    i32.const 640
    v128.const i64x2 -9223372036854775808 9223372036854775807
    v128.const i64x2 -1 3
    i64x2.sub v128.store
    i32.const 656
    v128.const i64x2 -9223372036854775808 9223372036854775807
    v128.const i64x2 -1 3
    i64x2.mul v128.store
  ))
