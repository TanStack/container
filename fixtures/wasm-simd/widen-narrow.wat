(module
  (memory (export "memory") 1)
  (func (export "run")
    i32.const 0
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i16x8.extend_low_i8x16_s
    v128.store
    i32.const 16
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i16x8.extend_low_i8x16_u
    v128.store
    i32.const 32
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i16x8.extend_high_i8x16_s
    v128.store
    i32.const 48
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i16x8.extend_high_i8x16_u
    v128.store
    i32.const 64
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 2 -1 3 4 -2 3 -4 5 -6 7 8 -9 10 11 -12 13
    i16x8.extmul_low_i8x16_s
    v128.store
    i32.const 80
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 2 -1 3 4 -2 3 -4 5 -6 7 8 -9 10 11 -12 13
    i16x8.extmul_low_i8x16_u
    v128.store
    i32.const 96
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 2 -1 3 4 -2 3 -4 5 -6 7 8 -9 10 11 -12 13
    i16x8.extmul_high_i8x16_s
    v128.store
    i32.const 112
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    v128.const i8x16 2 -1 3 4 -2 3 -4 5 -6 7 8 -9 10 11 -12 13
    i16x8.extmul_high_i8x16_u
    v128.store
    i32.const 128
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32x4.extend_low_i16x8_s
    v128.store
    i32.const 144
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32x4.extend_low_i16x8_u
    v128.store
    i32.const 160
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32x4.extend_high_i16x8_s
    v128.store
    i32.const 176
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32x4.extend_high_i16x8_u
    v128.store
    i32.const 192
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 2 -1 3 4 -2 3 -4 5
    i32x4.extmul_low_i16x8_s
    v128.store
    i32.const 208
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 2 -1 3 4 -2 3 -4 5
    i32x4.extmul_low_i16x8_u
    v128.store
    i32.const 224
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 2 -1 3 4 -2 3 -4 5
    i32x4.extmul_high_i16x8_s
    v128.store
    i32.const 240
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    v128.const i16x8 2 -1 3 4 -2 3 -4 5
    i32x4.extmul_high_i16x8_u
    v128.store
    i32.const 256
    v128.const i32x4 -2147483648 -1 2147483647 12345
    i64x2.extend_low_i32x4_s
    v128.store
    i32.const 272
    v128.const i32x4 -2147483648 -1 2147483647 12345
    i64x2.extend_low_i32x4_u
    v128.store
    i32.const 288
    v128.const i32x4 -2147483648 -1 2147483647 12345
    i64x2.extend_high_i32x4_s
    v128.store
    i32.const 304
    v128.const i32x4 -2147483648 -1 2147483647 12345
    i64x2.extend_high_i32x4_u
    v128.store
    i32.const 320
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 2 -1 -2 98765
    i64x2.extmul_low_i32x4_s
    v128.store
    i32.const 336
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 2 -1 -2 98765
    i64x2.extmul_low_i32x4_u
    v128.store
    i32.const 352
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 2 -1 -2 98765
    i64x2.extmul_high_i32x4_s
    v128.store
    i32.const 368
    v128.const i32x4 -2147483648 -1 2147483647 12345
    v128.const i32x4 2 -1 -2 98765
    i64x2.extmul_high_i32x4_u
    v128.store
    i32.const 384
    v128.const i16x8 -32768 -129 -128 -1 0 127 128 255
    v128.const i16x8 256 32767 -256 1 126 129 254 -2
    i8x16.narrow_i16x8_s
    v128.store
    i32.const 400
    v128.const i16x8 -32768 -129 -128 -1 0 127 128 255
    v128.const i16x8 256 32767 -256 1 126 129 254 -2
    i8x16.narrow_i16x8_u
    v128.store
    i32.const 416
    v128.const i32x4 -2147483648 -32769 -32768 -1
    v128.const i32x4 0 32767 65535 2147483647
    i16x8.narrow_i32x4_s
    v128.store
    i32.const 432
    v128.const i32x4 -2147483648 -32769 -32768 -1
    v128.const i32x4 0 32767 65535 2147483647
    i16x8.narrow_i32x4_u
    v128.store
    i32.const 448
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i16x8.extadd_pairwise_i8x16_s
    v128.store
    i32.const 464
    v128.const i8x16 -128 -1 0 1 127 -64 64 2 -2 3 4 5 6 7 8 9
    i16x8.extadd_pairwise_i8x16_u
    v128.store
    i32.const 480
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32x4.extadd_pairwise_i16x8_s
    v128.store
    i32.const 496
    v128.const i16x8 -32768 -1 0 1 32767 -123 123 2
    i32x4.extadd_pairwise_i16x8_u
    v128.store
    i32.const 512
    v128.const i16x8 -32768 -32768 32767 32767 -1 2 -123 456
    v128.const i16x8 -32768 -32768 32767 32767 3 -4 789 -12
    i32x4.dot_i16x8_s
    v128.store
    i32.const 528
    v128.const i16x8 -32768 32767 16384 1 -1 -16384 12345 -23456
    v128.const i16x8 -32768 32767 1 16384 16384 1 -12345 23456
    i16x8.q15mulr_sat_s
    v128.store
  ))
