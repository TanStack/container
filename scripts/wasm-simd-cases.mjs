// Runs unchanged with native WebAssembly or a future guest SIMD implementation.
// No guest success is implied until an interpreter executes these assertions.
export function runSIMDBasics(api,bytes){
  const instance=new api.Instance(new api.Module(new Uint8Array(bytes)))
  const exports=instance.exports,words=new Int32Array(exports.memory.buffer)
  words.set([7,17,27,37],4)
  exports.load_store(16,48)
  return {
    addLane:exports.add_lane(),multiplyLane:exports.multiply_lane(),
    localCall:exports.local_call(),floatLane:exports.float_lane(),
    source:Array.from(words.subarray(4,8)),stored:Array.from(words.subarray(12,16)),
  }
}
