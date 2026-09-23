export function runSIMDWiden(api,bytes){
  const names=["i16x8.extend_low_i8x16_s","i16x8.extend_low_i8x16_u","i16x8.extend_high_i8x16_s","i16x8.extend_high_i8x16_u","i16x8.extmul_low_i8x16_s","i16x8.extmul_low_i8x16_u","i16x8.extmul_high_i8x16_s","i16x8.extmul_high_i8x16_u","i32x4.extend_low_i16x8_s","i32x4.extend_low_i16x8_u","i32x4.extend_high_i16x8_s","i32x4.extend_high_i16x8_u","i32x4.extmul_low_i16x8_s","i32x4.extmul_low_i16x8_u","i32x4.extmul_high_i16x8_s","i32x4.extmul_high_i16x8_u","i64x2.extend_low_i32x4_s","i64x2.extend_low_i32x4_u","i64x2.extend_high_i32x4_s","i64x2.extend_high_i32x4_u","i64x2.extmul_low_i32x4_s","i64x2.extmul_low_i32x4_u","i64x2.extmul_high_i32x4_s","i64x2.extmul_high_i32x4_u","i8x16.narrow_i16x8_s","i8x16.narrow_i16x8_u","i16x8.narrow_i32x4_s","i16x8.narrow_i32x4_u","i16x8.extadd_pairwise_i8x16_s","i16x8.extadd_pairwise_i8x16_u","i32x4.extadd_pairwise_i16x8_s","i32x4.extadd_pairwise_i16x8_u","i32x4.dot_i16x8_s","i16x8.q15mulr_sat_s"]
  const {exports}=new api.Instance(new api.Module(new Uint8Array(bytes)))
  exports.run()
  const memory=new Uint8Array(exports.memory.buffer)
  return Object.fromEntries(names.map((name,index)=>[name,Array.from(memory.slice(index*16,index*16+16))]))
}

export const expectedSIMDWiden={
  "i16x8.extend_low_i8x16_s":[128,255,255,255,0,0,1,0,127,0,192,255,64,0,2,0],
  "i16x8.extend_low_i8x16_u":[128,0,255,0,0,0,1,0,127,0,192,0,64,0,2,0],
  "i16x8.extend_high_i8x16_s":[254,255,3,0,4,0,5,0,6,0,7,0,8,0,9,0],
  "i16x8.extend_high_i8x16_u":[254,0,3,0,4,0,5,0,6,0,7,0,8,0,9,0],
  "i16x8.extmul_low_i8x16_s":[0,255,1,0,0,0,4,0,2,255,64,255,0,255,10,0],
  "i16x8.extmul_low_i8x16_u":[0,1,1,254,0,0,4,0,2,126,64,2,0,63,10,0],
  "i16x8.extmul_high_i8x16_s":[12,0,21,0,32,0,211,255,60,0,77,0,160,255,117,0],
  "i16x8.extmul_high_i8x16_u":[12,248,21,0,32,0,211,4,60,0,77,0,160,7,117,0],
  "i32x4.extend_low_i16x8_s":[0,128,255,255,255,255,255,255,0,0,0,0,1,0,0,0],
  "i32x4.extend_low_i16x8_u":[0,128,0,0,255,255,0,0,0,0,0,0,1,0,0,0],
  "i32x4.extend_high_i16x8_s":[255,127,0,0,133,255,255,255,123,0,0,0,2,0,0,0],
  "i32x4.extend_high_i16x8_u":[255,127,0,0,133,255,0,0,123,0,0,0,2,0,0,0],
  "i32x4.extmul_low_i16x8_s":[0,0,255,255,1,0,0,0,0,0,0,0,4,0,0,0],
  "i32x4.extmul_low_i16x8_u":[0,0,1,0,1,0,254,255,0,0,0,0,4,0,0,0],
  "i32x4.extmul_high_i16x8_s":[2,0,255,255,143,254,255,255,20,254,255,255,10,0,0,0],
  "i32x4.extmul_high_i16x8_u":[2,0,254,127,143,254,2,0,20,254,122,0,10,0,0,0],
  "i64x2.extend_low_i32x4_s":[0,0,0,128,255,255,255,255,255,255,255,255,255,255,255,255],
  "i64x2.extend_low_i32x4_u":[0,0,0,128,0,0,0,0,255,255,255,255,0,0,0,0],
  "i64x2.extend_high_i32x4_s":[255,255,255,127,0,0,0,0,57,48,0,0,0,0,0,0],
  "i64x2.extend_high_i32x4_u":[255,255,255,127,0,0,0,0,57,48,0,0,0,0,0,0],
  "i64x2.extmul_low_i32x4_s":[0,0,0,0,255,255,255,255,1,0,0,0,0,0,0,0],
  "i64x2.extmul_low_i32x4_u":[0,0,0,0,1,0,0,0,1,0,0,0,254,255,255,255],
  "i64x2.extmul_high_i32x4_s":[2,0,0,0,255,255,255,255,165,86,172,72,0,0,0,0],
  "i64x2.extmul_high_i32x4_u":[2,0,0,0,254,255,255,127,165,86,172,72,0,0,0,0],
  "i8x16.narrow_i16x8_s":[128,128,128,255,0,127,127,127,127,127,128,1,126,127,127,254],
  "i8x16.narrow_i16x8_u":[0,0,0,0,0,127,128,255,255,255,0,1,126,129,254,0],
  "i16x8.narrow_i32x4_s":[0,128,0,128,0,128,255,255,0,0,255,127,255,127,255,127],
  "i16x8.narrow_i32x4_u":[0,0,0,0,0,0,0,0,0,0,255,127,255,255,255,255],
  "i16x8.extadd_pairwise_i8x16_s":[127,255,1,0,63,0,66,0,1,0,9,0,13,0,17,0],
  "i16x8.extadd_pairwise_i8x16_u":[127,1,1,0,63,1,66,0,1,1,9,0,13,0,17,0],
  "i32x4.extadd_pairwise_i16x8_s":[255,127,255,255,1,0,0,0,132,127,0,0,125,0,0,0],
  "i32x4.extadd_pairwise_i16x8_u":[255,127,1,0,1,0,0,0,132,127,1,0,125,0,0,0],
  "i32x4.dot_i16x8_s":[0,0,0,128,2,0,254,127,245,255,255,255,137,111,254,255],
  "i16x8.q15mulr_sat_s":[255,127,254,127,1,0,1,0,0,0,0,0,213,237,106,190],
}
