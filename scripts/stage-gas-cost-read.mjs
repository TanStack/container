import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function stageGasCostRead(directory){
  const path=join(directory,'m3_exec.h'),source=readFileSync(path,'utf8')
  const start=source.indexOf('d_m3Op(UseGas)\n{')
  const end=source.indexOf('\n}\n',start)
  if(start<0||end<0)throw Error('Missing gas operation')
  let operation=source.slice(start,end)
  const replace=(from,to)=>{
    if(operation.split(from).length!==2)throw Error('Unexpected gas operation site')
    operation=operation.replace(from,to)
  }
  replace('    u32        cost = immediate(u32);',
    '    /* Advance on both paths, but read the cost only for fallback gas. */\n    pc_t gasPC = _pc++;')
  replace('    runtime->gasRemaining -= (i64)cost;',
    '    u32 cost = *(u32 *)gasPC;\n    runtime->gasRemaining -= (i64)cost;')
  writeFileSync(path,source.slice(0,start)+operation+source.slice(end))
}
