export function runSIMDMemory(api,bytes){
  const names=["load8x8_s","load8x8_u","load16x4_s","load16x4_u","load32x2_s","load32x2_u","load8_splat","load16_splat","load32_splat","load64_splat","load32_zero","load64_zero","load8_lane","load16_lane","load32_lane","load64_lane","store8_lane","store16_lane","store32_lane","store64_lane","load8_lane_boundary","load16_lane_boundary","load32_lane_boundary","load64_lane_boundary"]
  const {exports}=new api.Instance(new api.Module(new Uint8Array(bytes)))
  const memory=new Uint8Array(exports.memory.buffer)
  memory.set([128,255,127,0,1,129,85,170,254,2,128,127,255,0,3,192],1003)
  memory.fill(238,2000,2400)
  memory.set([248,249,250,251,252,253,254,255],65528)
  exports.run()
  return Object.fromEntries(names.map((name,index)=>{
    const offset=name.startsWith('store')?2000+index*16:index*16
    return [name,Array.from(memory.slice(offset,offset+16))]
  }))
}

export const expectedSIMDMemory={
  "load8x8_s":[128,255,255,255,127,0,0,0,1,0,129,255,85,0,170,255],
  "load8x8_u":[128,0,255,0,127,0,0,0,1,0,129,0,85,0,170,0],
  "load16x4_s":[128,255,255,255,127,0,0,0,1,129,255,255,85,170,255,255],
  "load16x4_u":[128,255,0,0,127,0,0,0,1,129,0,0,85,170,0,0],
  "load32x2_s":[128,255,127,0,0,0,0,0,1,129,85,170,255,255,255,255],
  "load32x2_u":[128,255,127,0,0,0,0,0,1,129,85,170,0,0,0,0],
  "load8_splat":[128,128,128,128,128,128,128,128,128,128,128,128,128,128,128,128],
  "load16_splat":[128,255,128,255,128,255,128,255,128,255,128,255,128,255,128,255],
  "load32_splat":[128,255,127,0,128,255,127,0,128,255,127,0,128,255,127,0],
  "load64_splat":[128,255,127,0,1,129,85,170,128,255,127,0,1,129,85,170],
  "load32_zero":[128,255,127,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "load64_zero":[128,255,127,0,1,129,85,170,0,0,0,0,0,0,0,0],
  "load8_lane":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,128],
  "load16_lane":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,128,255],
  "load32_lane":[16,17,18,19,20,21,22,23,24,25,26,27,128,255,127,0],
  "load64_lane":[16,17,18,19,20,21,22,23,128,255,127,0,1,129,85,170],
  "store8_lane":[238,238,238,31,238,238,238,238,238,238,238,238,238,238,238,238],
  "store16_lane":[238,238,238,30,31,238,238,238,238,238,238,238,238,238,238,238],
  "store32_lane":[238,238,238,28,29,30,31,238,238,238,238,238,238,238,238,238],
  "store64_lane":[238,238,238,24,25,26,27,28,29,30,31,238,238,238,238,238],
  "load8_lane_boundary":[255,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],
  "load16_lane_boundary":[254,255,18,19,20,21,22,23,24,25,26,27,28,29,30,31],
  "load32_lane_boundary":[252,253,254,255,20,21,22,23,24,25,26,27,28,29,30,31],
  "load64_lane_boundary":[248,249,250,251,252,253,254,255,24,25,26,27,28,29,30,31],
}
