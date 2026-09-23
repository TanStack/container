type TimingModule={
  _QTS_WasmModuleTimingReset?:(enabled:number)=>void
  _QTS_WasmModuleTimingRead?:(field:number)=>number
}

/** Host-only observer. Old engines remain usable without stage diagnostics. */
export function createWasmModuleTiming(module:TimingModule){
  const reset=module._QTS_WasmModuleTimingReset,read=module._QTS_WasmModuleTimingRead
  if(typeof reset!=='function'||typeof read!=='function')return undefined
  const hasResetTiming=read(-1)>=9
  const totals={copyMs:0,setupMs:0,parseMs:0,validationMs:0,sourceBytes:0,calls:0,validated:0}
  const resetTotals={resetMs:0,resetCalls:0,resetBytes:0}
  return {
    begin(){reset(1)},
    end(){
      try{
        const values=Array.from({length:hasResetTiming?9:6},(_,field)=>read(field))
        if(!values.every(value=>Number.isFinite(value)&&value>=0))return
        totals.copyMs+=values[0];totals.setupMs+=values[1]
        totals.parseMs+=values[2];totals.validationMs+=values[3]
        totals.sourceBytes+=values[4];totals.calls++;totals.validated+=values[5]===1?1:0
        if(hasResetTiming){resetTotals.resetMs+=values[6];resetTotals.resetCalls+=values[7];resetTotals.resetBytes+=values[8]}
      }finally{reset(0)}
    },
    snapshot(){return {...totals,...(hasResetTiming?resetTotals:{})}},
  }
}
