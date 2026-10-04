export function nativeGateCellTimeout(value){
  if(value===undefined)return 300000
  if(!/^\d+$/.test(String(value)))throw Error('NATIVE_GATE_CELL_TIMEOUT_MS must be an integer from 1 to 3600000')
  const milliseconds=Number(value)
  if(!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>3600000)
    throw Error('NATIVE_GATE_CELL_TIMEOUT_MS must be an integer from 1 to 3600000')
  return milliseconds
}

export function nativeGateTestArguments(timeout,path){
  return ['--test',`--test-timeout=${nativeGateCellTimeout(timeout)}`,'--test-force-exit',path]
}
