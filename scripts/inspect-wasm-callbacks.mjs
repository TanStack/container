// Read-only table-slot mapping for the installed binding's active element format.
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const [input,...requested]=process.argv.slice(2)
if(!input)throw Error('Usage: node scripts/inspect-wasm-callbacks.mjs file.wasm [table-slot ...]')
const slots=requested.map(value=>{const slot=Number(value);if(!Number.isSafeInteger(slot)||slot<0)throw Error('Invalid table slot');return slot})
const bytes=readFileSync(input)
const module=await WebAssembly.compile(bytes)
const importedFunctions=WebAssembly.Module.imports(module).filter(entry=>entry.kind==='function').length
let position=8
function uleb(){let value=0,shift=0;for(let count=0;count<5;count++){if(position>=bytes.length)throw Error('Truncated LEB');const byte=bytes[position++];value+=(byte&127)*2**shift;if(!(byte&128))return value;shift+=7}throw Error('Unsupported LEB')}
function string(){const length=uleb();const end=position+length;if(end>bytes.length)throw Error('Truncated string');const value=bytes.subarray(position,end).toString('utf8');position=end;return value}
const table=new Map(),exportsByFunction=new Map(),bodies=new Map(),customSections=[]
while(position<bytes.length){
  const section=bytes[position++],size=uleb(),end=position+size
  if(end>bytes.length)throw Error('Truncated section')
  if(section===0)customSections.push(string())
  if(section===7){
    const count=uleb()
    for(let i=0;i<count;i++){const name=string(),kind=bytes[position++],index=uleb();if(kind===0){const names=exportsByFunction.get(index)??[];names.push(name);exportsByFunction.set(index,names)}}
  }
  if(section===9){
    const count=uleb()
    for(let i=0;i<count;i++){
      const flags=uleb()
      if(flags!==0)throw Error('Only active table-zero function-index elements are supported')
      if(bytes[position++]!==0x41)throw Error('Expected i32.const table offset')
      const offset=uleb()
      if(bytes[position++]!==0x0b)throw Error('Expected end of table offset')
      const length=uleb()
      for(let j=0;j<length;j++)table.set(offset+j,uleb())
    }
  }
  if(section===10){const count=uleb();for(let i=0;i<count;i++){const length=uleb();bodies.set(importedFunctions+i,{offset:position,length});position+=length}}
  if(position>end)throw Error('Section parsing overflow')
  position=end
}
const mappings=slots.map(slot=>{const index=table.get(slot);return {slot,functionIndex:index,exports:index===undefined?[]:exportsByFunction.get(index)??[],body:index===undefined?undefined:bodies.get(index)}})
console.log(JSON.stringify({file:resolve(input),customSections,hasFunctionNames:customSections.includes('name'),importedFunctions,initializedSlots:table.size,mappings},null,2))
