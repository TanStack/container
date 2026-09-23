import type {QuickJSContext,QuickJSHandle} from 'quickjs-emscripten-core'
import type {ModuleMessageSender} from './module-message'

type NativeContext={ctx:{value:number};module:{HEAPU8:Uint8Array;cwrap(name:string,result:string,args:string[]):(...args:number[])=>number}}

/** Trusted host-only boundary. Returns an owned message ID, never a borrowed view.
 * The caller supplies the private native module handle, not source addresses.
 * retain checks the envelope budget before making its independent host copy.
 */
export function retainModuleSource(context:QuickJSContext,value:QuickJSHandle,sender:ModuleMessageSender):number{
  context.runtime.assertOwned(value)
  const held=value.dup()
  try{
    const native=context as unknown as NativeContext
    const inspect=native.module.cwrap('QTS_WasmModuleSourceInfo','number',['number','number','number'])
    const length=inspect(native.ctx.value,held.value,0)
    const offset=inspect(native.ctx.value,held.value,1)
    const heap=native.module.HEAPU8
    if(!Number.isSafeInteger(length)||length<1||!Number.isSafeInteger(offset)||offset<0||offset>heap.byteLength||length>heap.byteLength-offset)
      throw new TypeError('Expected a validated native WASM module')
    // No await, native call, or guest callback between borrowing and copying.
    return sender.retain(heap.subarray(offset,offset+length))
  }finally{held.dispose()}
}
