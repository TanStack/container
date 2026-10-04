import {expect,test,vi} from 'vitest'
import {createInlinedModuleFunction} from '../src/native/inlined-module-function'

test('modules can shadow Function with lexical and function declarations',async()=>{
  for(const declaration of ['const Function=()=>42','class Function {static answer=42}','function Function(){return 42}']){
    const exports:any={}
    await createInlinedModuleFunction(['exports'],`${declaration};exports.answer=Function.answer??Function()`,Function)(exports)
    expect(exports.answer).toBe(42)
  }
})
test('unshadowed modules use the supplied constructor and retain strict async scope',async()=>{
  const guest=vi.fn(()=>()=>5),exports:any={}
  await createInlinedModuleFunction(['exports'],'exports.answer=await Function("return 5")();exports.receiver=this',guest)(exports)
  expect(guest).toHaveBeenCalledWith('return 5')
  expect(exports).toEqual({answer:5,receiver:undefined})
})
