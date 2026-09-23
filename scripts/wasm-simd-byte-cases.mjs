export function runSIMDBytes(api,bytes){
  const {exports}=new api.Instance(new api.Module(new Uint8Array(bytes)))
  exports.run()
  const memory=new Uint8Array(exports.memory.buffer)
  return {
    vectors:Array.from({length:9},(_,index)=>Array.from(memory.slice(index*16,index*16+16))),
    signed:exports.signed(),unsigned:exports.unsigned(),zero:exports.zero(),nonzero:exports.nonzero(),
  }
}

export const expectedSIMDBytes={
  vectors:[
    [255,240,170,85,0,127,128,254,253,252,251,250,249,248,247,246],
    [0,0,0,0,15,0,0,0,0,0,0,0,0,0,0,0],
    [0,15,85,170,240,128,127,1,2,3,4,5,6,7,8,9],
    [255,255,255,255,255,255,255,17,34,51,68,85,102,119,136,153],
    [255,255,255,255,240,255,255,17,34,51,68,85,102,119,136,153],
    [170,90,165,165,15,255,255,0,2,48,4,80,102,0,128,9],
    [0,255,15,240,85,170,170,85,6,96,7,112,8,128,9,144],
    [9,0,1,0,0,0,0,2,15,85,170,255,128,127,8,7],
    [130,130,130,255,130,130,130,130,130,130,130,130,130,130,130,130],
  ],
  signed:-128,unsigned:128,zero:0,nonzero:1,
}
