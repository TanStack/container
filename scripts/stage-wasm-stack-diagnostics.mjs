import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function stageWasmStackDiagnostics(directory){
  const path=join(directory,'m3_exec.h')
  let source=readFileSync(path,'utf8')
  const native='newTrap (m3Err_trapStackOverflow);'
  const slots='newTrap(m3Err_trapStackOverflow);'
  if(source.split(native).length!==2||source.split(slots).length!==2)throw Error('Unexpected WASM stack guard source')
  source=source.replace(native,'newTrap ("[trap] stack overflow (native stack limit)");')
  source=source.replace(slots,'newTrap("[trap] stack overflow (value stack limit)");')
  writeFileSync(path,source)
}
