export function runSIMDLanes(api,bytes){
  const {exports}=new api.Instance(new api.Module(new Uint8Array(bytes)))
  exports.run()
  const memory=new Uint8Array(exports.memory.buffer)
  return {
    vectors:Array.from({length:5},(_,index)=>Array.from(memory.slice(index*16,index*16+16))),
    signed:exports.i16_signed(),unsigned:exports.i16_unsigned(),
    low:String(exports.i64_low()),high:String(exports.i64_high()),
    f32NegativeZero:Object.is(exports.f32_zero(),-0),f64NegativeZero:Object.is(exports.f64_zero(),-0),
    f64Value:exports.f64_value(),
  }
}

export const expectedSIMDLanes={
  vectors:[
    [0,128,0,128,0,128,255,255,0,128,0,128,0,128,0,128],
    [0,0,0,128,0,0,0,128,255,255,255,127,255,255,255,255],
    [0,0,0,0,0,0,0,128,255,255,255,255,255,255,255,127],
    [0,0,192,63,0,0,0,128,0,0,32,192,0,0,96,64],
    [0,0,0,0,0,0,0,128,0,0,0,0,0,0,248,63],
  ],
  signed:-32768,unsigned:32768,low:'-9223372036854775808',high:'9223372036854775807',
  f32NegativeZero:true,f64NegativeZero:true,f64Value:-2.5,
}
