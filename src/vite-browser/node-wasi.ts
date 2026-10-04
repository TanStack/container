import {WASI as RuntimeWASI} from '@tybys/wasm-util'
import * as fs from './node-fs'

/** Node's WASI surface, backed by the browser-owned project filesystem. */
export class WASI extends RuntimeWASI {
  constructor(options:ConstructorParameters<typeof RuntimeWASI>[0]){
    super({...options,fs:fs as never})
  }
}

export default {WASI}
