// Trusted local architecture experiment, not a production guest boundary.
import {installNativeContext} from './native-context.js'
import {Volume, createFsFromVolume} from 'memfs'
import {IncomingRequest} from '../sandbox/incoming-request.ts'

let handler, volume, moduleURL
installNativeContext({hostCallbacks:true})
self.onmessage = async ({data}) => {
  const started = performance.now()
  try {
    let value
    if (data.operation === 'load') {
      ;(0,eval)(data.bootstrap)
      volume = Volume.fromJSON(data.files ?? {})
      const fs = createFsFromVolume(volume)
      const fsSync = Object.fromEntries(Object.keys(fs).filter(key=>key.endsWith('Sync')).map(key=>[key.slice(0,-4),fs[key].bind(fs)]))
      globalThis.__webContainerHost = {
        env:{NODE_ENV:'production'},argv:[],fs:fs.promises,fsSync,
        AsyncLocalStorage:globalThis.__engineAsyncLocalStorage,
        randomBytes:size=>JSON.stringify(Array.from(crypto.getRandomValues(new Uint8Array(size)))),
      }
      // Node nextTick is intentionally not claimed here.
      Object.defineProperty(globalThis,Symbol.for('web-container:task-queue'),{value:{
        mode:'approximate-microtask',nextTick:queueMicrotask,
        task:(callback,receiver,args=[])=>Reflect.apply(callback,receiver,args),
      },configurable:true})
      moduleURL = URL.createObjectURL(new Blob([data.code],{type:'text/javascript'}))
      const module = await import(/* @vite-ignore */ moduleURL)
      handler = module.default?.fetch?.bind(module.default) ?? module.fetch ?? module.default
      if (typeof handler !== 'function') throw Error('No fetch handler')
      value = {loaded:true}
    } else if (data.operation === 'request') {
      const response = await handler(new IncomingRequest(data.url,{method:data.method ?? 'GET',body:data.body,headers:data.headers}))
      value = {status:response.status,headers:[...response.headers],body:await response.text()}
    } else if (data.operation === 'snapshot') {
      value = volume.toJSON()
    } else throw Error('Unknown operation')
    self.postMessage({id:data.id,ok:true,value,durationMs:performance.now()-started})
  } catch(error) {
    self.postMessage({id:data.id,ok:false,error:String(error),stack:error?.stack,durationMs:performance.now()-started})
  }
}
