export interface GuestBundlerTransport {
  create():number
  start(handle:number,method:'generate'|'write'|'scan'|'close',options:unknown):number
  next(operation:number):Promise<any>
  reply(operation:number,callback:number,result:unknown):void
  finish(operation:number):void
  cancel(operation:number):void
  context(scope:number,handle:number,method:'resolve'|'load',args:unknown):Promise<unknown>
  reportError(message:string):void
}
export interface GuestBindingBundler {
  readonly closed:boolean
  getWatchFiles():string[]
  generate(options:unknown):Promise<any>
  write(options:unknown):Promise<any>
  scan(options:unknown):Promise<any>
  close():Promise<void>
}
export function createGuestBundlerAdapter(transport:GuestBundlerTransport,scopeStore:{run<T>(scope:number,callback:()=>T):T},restoreBindingResult:(encoded:unknown)=>any,options:{maxBytes:number;maxCallbacks?:number}):{
  new():GuestBindingBundler
  startAsyncRuntime():void
  shutdownAsyncRuntime():void
  unsupportedRuntimeConstructor(name:string):new(...args:any[])=>never
}
