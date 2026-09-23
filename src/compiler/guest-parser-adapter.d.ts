import type {GuestCallableCallbackOrigin} from './guest-callable-dispatch'
import type {NativeParserOptions,NativeParserResult} from './rolldown-parser'

export function createGuestParserAdapter(
  host:(filename:string,source:string,options:NativeParserOptions|undefined,operation:number|undefined,callback:number|undefined)=>Promise<string>,
  callbackScope:{getStore():GuestCallableCallbackOrigin|undefined},
):(filename:string,source:string,options?:NativeParserOptions)=>Promise<NativeParserResult>
