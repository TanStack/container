import {
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core'
import ASYNCIFY from '@jitl/quickjs-wasmfile-release-asyncify'
import wasmURL from '@jitl/quickjs-wasmfile-release-asyncify/wasm?url'

// Architecture experiment, not a complete Node backend. Host RPC stays async;
// Asyncify suspends the interpreter stack while guest readFileSync waits.
self.onmessage = async (event) => {
  if (event.data.type !== 'execute') return
  const { code, env, argv, maxBytes, timeoutMs } = event.data
  const engine = await newQuickJSAsyncWASMModuleFromVariant(
    newVariant(ASYNCIFY, {
      wasmLocation: new URL(wasmURL, location.href).href,
    }),
  )
  const runtime = engine.newRuntime()
  runtime.setMemoryLimit(maxBytes)
  runtime.setMaxStackSize(256 * 1024)
  const deadline = performance.now() + timeoutMs
  runtime.setInterruptHandler(() => performance.now() > deadline)
  const context = runtime.newContext()
  let nextId = 0
  const pending = new Map<
    number,
    { resolve(value: string): void; reject(error: Error): void }
  >()
  // Do not re-enter QuickJS in a message callback while the stack is suspended.
  self.onmessage = (event) => {
    if (event.data.type !== 'fs-result') return
    const call = pending.get(event.data.id)
    if (!call) return
    pending.delete(event.data.id)
    event.data.error
      ? call.reject(new Error(event.data.error))
      : call.resolve(event.data.value)
  }
  try {
    const rpc = context.newAsyncifiedFunction(
      '__syncFS',
      async (method, args) => {
        const methodText = context.getString(method),
          argsText = context.getString(args)
        const id = ++nextId
        const value = await new Promise<string>((resolve, reject) => {
          pending.set(id, { resolve, reject })
          self.postMessage({
            type: 'fs',
            id,
            method: methodText,
            args: argsText,
          })
        })
        if (performance.now() > deadline) throw new Error('Execution timed out')
        return context.newString(value)
      },
    )
    context.setProp(context.global, '__syncFS', rpc)
    rpc.dispose()
    const print = context.newFunction('__print', (level, text) => {
      self.postMessage({
        type: 'output',
        level: context.getString(level),
        text: context.getString(text),
      })
    })
    context.setProp(context.global, '__print', print)
    print.dispose()
    context
      .unwrapResult(
        context.evalCode(`(() => {
      const rpc=__syncFS, print=__print;
      Object.defineProperty(globalThis,Symbol.for('web-container:task-queue'),{value:{
        mode:'synchronous-only',
        nextTick(){throw Object.assign(Error('Asyncify probe does not support async job scheduling'),{code:'ERR_UNSUPPORTED_OPERATION'})},
        task:(callback,receiver,args=[])=>Reflect.apply(callback,receiver,args),
      }});
      delete globalThis.__syncFS; delete globalThis.__print;
      const call=(method,args)=>JSON.parse(rpc(method,JSON.stringify(args)));
      const fsSync={
        readFile:(path,options)=>{const value=call('readFile',[path,options]);return value?.bytes?new Uint8Array(value.bytes):value},
        writeFile:(path,value,options)=>{
          if(typeof value!=='string'&&!(value instanceof Uint8Array))throw new TypeError('Expected string or Uint8Array');
          return call('writeFile',[path,typeof value==='string'?value:{bytes:Array.from(value)},options]);
        },
        readdir:(path,options)=>call('readdir',[path,options]),
        exists:path=>call('exists',[path]),realpath:path=>call('realpath',[path]),
        symlink:(...args)=>call('symlink',args),readlink:(...args)=>call('readlink',args),lstat:(...args)=>call('lstat',args),
        stat:path=>{const v=call('stat',[path]);return {...v,isFile:()=>v.kind==='file',isDirectory:()=>v.kind==='directory'}}
      };
      for(const method of ['mkdir','rmdir','rm','unlink','rename','copyFile','truncate','chmod','access'])fsSync[method]=(...args)=>call(method,args);
      globalThis.__webContainerHost={fsSync,env:${JSON.stringify(env)},argv:${JSON.stringify(argv)}};
      globalThis.console=Object.fromEntries(['log','info','warn','error','debug'].map(level=>[level,(...args)=>print(level,args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '))]));
    })()`),
      )
      .dispose()
    const evaluation = await context.evalCodeAsync(code, 'workspace.mjs', {
      type: 'module',
    })
    if (evaluation.error) {
      const error = context.dump(evaluation.error)
      evaluation.dispose()
      throw new Error(error?.message ?? JSON.stringify(error))
    }
    try {
      const state = context.getPromiseState(evaluation.value)
      if (state.type === 'rejected') {
        const error = context.dump(state.error)
        state.error.dispose()
        throw new Error(error?.message ?? JSON.stringify(error))
      }
      if (state.type === 'fulfilled' && !state.notAPromise)
        state.value.dispose()
      if (state.type === 'pending' || runtime.hasPendingJob())
        throw new Error(
          'Asyncify probe supports synchronous modules only; async job scheduling is not implemented',
        )
    } finally {
      evaluation.dispose()
    }
    self.postMessage({ type: 'done' })
  } catch (error) {
    self.postMessage({ type: 'error', error: String(error) })
  } finally {
    self.onmessage = null
    context.dispose()
    runtime.dispose()
  }
}
