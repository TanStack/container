/** Load VM code through the browser's native module loader. */
export function loadBrowserVmModule<T>(load:()=>Promise<T>):Promise<T>{
  return trackNodeCommandPromise(load())
}
import {trackNodeCommandPromise} from '../vite-browser/node-timers'
