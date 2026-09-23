import {AsyncLocalStorage} from 'node:async_hooks'
export const storage=new AsyncLocalStorage()
export const count=globalThis.nestedWorkerCount=(globalThis.nestedWorkerCount??0)+1
