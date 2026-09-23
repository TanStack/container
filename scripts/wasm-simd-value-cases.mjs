// A native reference and future guest differential share this exact runner.
export function runSIMDValueMovement(api,bytes){
  const {exports}=new api.Instance(new api.Module(new Uint8Array(bytes)))
  return {
    direct:exports.direct(),indirect:exports.indirect(),
    globals:[exports.globals(),exports.globals()],
    select:[exports.choose(0),exports.choose(1)],
    branch:[exports.branch(0),exports.branch(1)],locals:exports.locals(),
  }
}
export const expectedSIMDValueMovement={direct:30,indirect:24,globals:[31,32],select:[22,12],branch:[43,33],locals:444}
