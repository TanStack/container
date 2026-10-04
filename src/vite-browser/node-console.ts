import {format,inspect} from './node-util'

type Output={write:(text:string)=>unknown}
type Options={stdout:Output;stderr?:Output;ignoreErrors?:boolean}

/** Stream-backed console for guest tools, independent of the host console. */
export class Console{
  readonly #stdout:Output
  readonly #stderr:Output
  readonly #ignoreErrors:boolean
  constructor(stdout:Output|Options,stderr?:Output,ignoreErrors=true){
    const options='stdout' in stdout?stdout:{stdout,stderr,ignoreErrors}
    if(typeof options.stdout?.write!=='function'||options.stderr&&typeof options.stderr.write!=='function')
      throw new TypeError('Console expects writable stdout and stderr streams')
    this.#stdout=options.stdout
    this.#stderr=options.stderr??options.stdout
    this.#ignoreErrors=options.ignoreErrors??true
    for(const name of ['log','info','debug','warn','error','dir','assert','trace'] as const)
      this[name]=this[name].bind(this) as never
  }
  #write(stream:Output,text:string){
    try{stream.write(text+'\n')}
    catch(error){if(!this.#ignoreErrors)throw error}
  }
  #format(args:unknown[]){
    if(typeof args[0]==='string')return format(...args)
    return args.map(value=>value instanceof Error?value.stack??String(value):format(value)).join(' ')
  }
  log(...args:unknown[]){this.#write(this.#stdout,this.#format(args))}
  info(...args:unknown[]){this.log(...args)}
  debug(...args:unknown[]){this.log(...args)}
  warn(...args:unknown[]){this.#write(this.#stderr,this.#format(args))}
  error(...args:unknown[]){this.warn(...args)}
  dir(value:unknown,options?:Record<string,unknown>){this.#write(this.#stdout,inspect(value,options))}
  assert(condition:unknown,...args:unknown[]){if(!condition)this.warn('Assertion failed'+(args.length?': '+format(...args):''))}
  trace(...args:unknown[]){const error=new Error(format(...args));error.name='Trace';this.#write(this.#stderr,error.stack??String(error))}
}

export const log=(...args:unknown[])=>globalThis.console.log(...args)
export const info=(...args:unknown[])=>globalThis.console.info(...args)
export const debug=(...args:unknown[])=>globalThis.console.debug(...args)
export const warn=(...args:unknown[])=>globalThis.console.warn(...args)
export const error=(...args:unknown[])=>globalThis.console.error(...args)
export const dir=(value:unknown,options?:Record<string,unknown>)=>globalThis.console.dir(value,options)
export const assert=(condition:unknown,...args:unknown[])=>globalThis.console.assert(condition,...args)
export const trace=(...args:unknown[])=>globalThis.console.trace(...args)
export default {Console,log,info,debug,warn,error,dir,assert,trace}
