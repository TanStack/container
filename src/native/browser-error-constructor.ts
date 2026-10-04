/** Preserve native error construction while translating verified stack locations. */
export function createBrowserErrorConstructor<T extends ErrorConstructor>(native:T,mapStack:(stack:string)=>string):T{
  function map(error:Error){
    let owner:object|null=error
    let descriptor:PropertyDescriptor|undefined
    while(owner&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(owner,'stack');owner=Object.getPrototypeOf(owner)}
    if(descriptor&&'value' in descriptor&&typeof descriptor.value==='string'&&descriptor.configurable)
      Object.defineProperty(error,'stack',{...descriptor,value:mapStack(descriptor.value)})
    else if(descriptor?.get&&descriptor.configurable){
      let replaced=false
      Object.defineProperty(error,'stack',{...descriptor,get(){
        const stack=descriptor.get!.call(this)
        if(replaced)return stack
        return typeof stack==='string'?mapStack(stack):stack
      },set:descriptor.set?function(value){descriptor.set!.call(this,value);replaced=true}:undefined})
    }
    return error
  }
  const capture=(native as ErrorConstructor & {captureStackTrace?:(target:object,constructor?:Function)=>void}).captureStackTrace
  const mappedCapture=capture?function(target:object,constructor?:Function){
    Reflect.apply(capture,native,[target,constructor])
    map(target as Error)
  }:undefined
  return new Proxy(native,{
    get(target,key,receiver){
      if(key==='captureStackTrace'&&Reflect.get(target,key,receiver)===capture){
        const descriptor=Object.getOwnPropertyDescriptor(target,key)
        if(descriptor&&!descriptor.configurable&&'value' in descriptor&&!descriptor.writable)return capture
        return mappedCapture
      }
      return Reflect.get(target,key,receiver)
    },
    apply(target,receiver,args){return map(Reflect.apply(target,receiver,args))},
    construct(target,args,newTarget){return map(Reflect.construct(target,args,newTarget))},
  })
}

/** Install only in an owned worker realm, never in the application's realm. */
export function installBrowserErrorConstructor(scope:{Error:ErrorConstructor},mapStack:(stack:string)=>string){
  const native=scope.Error
  const constructor=Object.getOwnPropertyDescriptor(native.prototype,'constructor')
  const global=Object.getOwnPropertyDescriptor(scope,'Error')
  if(!constructor?.configurable||!global||!('value' in global)||!global.writable)
    throw new TypeError('Error constructor cannot be installed in this realm')
  const mapped=createBrowserErrorConstructor(native,mapStack)
  Object.defineProperty(native.prototype,'constructor',{...constructor,value:mapped})
  Object.defineProperty(scope,'Error',{...global,value:mapped})
  return mapped
}
