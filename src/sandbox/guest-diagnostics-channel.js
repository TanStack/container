const registry=new Map()

const invalid=(name,expected,value)=>Object.assign(new TypeError('The "'+name+'" argument must be of type '+expected+'. Received '+typeof value),{code:'ERR_INVALID_ARG_TYPE'})
const validName=name=>{if(typeof name!=='string'&&typeof name!=='symbol')throw invalid('name','string or symbol',name);return name}

export class Channel {
  constructor(name){
    this.name=validName(name)
    this._subscribers=new Set()
    registry.set(name,this)
  }
  get hasSubscribers(){return this._subscribers.size>0}
  subscribe(onMessage){if(typeof onMessage!=='function')throw invalid('subscription','function',onMessage);this._subscribers.add(onMessage)}
  unsubscribe(onMessage){return typeof onMessage==='function'&&this._subscribers.delete(onMessage)}
  publish(message){for(const subscriber of [...this._subscribers])subscriber(message,this.name)}
}

export function channel(name){name=validName(name);return registry.get(name)??new Channel(name)}
export function hasSubscribers(name){return registry.get(validName(name))?.hasSubscribers??false}
export function subscribe(name,onMessage){channel(name).subscribe(onMessage)}
export function unsubscribe(name,onMessage){return registry.get(validName(name))?.unsubscribe(onMessage)??false}

export function tracingChannel(nameOrChannels){
  let channels
  if(typeof nameOrChannels==='string'){
    const prefix=nameOrChannels
    channels=Object.fromEntries(['start','end','asyncStart','asyncEnd','error'].map(part=>[part,channel('tracing:'+prefix+':'+part)]))
  }else if(nameOrChannels&&typeof nameOrChannels==='object')channels=nameOrChannels
  else throw invalid('nameOrChannels','string or object',nameOrChannels)
  for(const part of ['start','end','asyncStart','asyncEnd','error'])if(!channels[part]||typeof channels[part].publish!=='function')throw invalid('channels.'+part,'Channel',channels[part])
  return Object.assign(Object.create(null),channels,{
    traceSync(fn,context={},thisArg,...args){
      if(typeof fn!=='function')throw invalid('fn','function',fn)
      channels.start.publish(context)
      try{const result=Reflect.apply(fn,thisArg,args);context.result=result;return result}
      catch(error){context.error=error;channels.error.publish(context);throw error}
      finally{channels.end.publish(context)}
    },
    tracePromise(fn,context={},thisArg,...args){
      if(typeof fn!=='function')throw invalid('fn','function',fn)
      channels.start.publish(context)
      let promise
      try{promise=Reflect.apply(fn,thisArg,args)}catch(error){context.error=error;channels.error.publish(context);channels.end.publish(context);throw error}
      channels.end.publish(context)
      return Promise.resolve(promise).then(result=>{context.result=result;channels.asyncStart.publish(context);channels.asyncEnd.publish(context);return result},error=>{context.error=error;channels.error.publish(context);channels.asyncStart.publish(context);channels.asyncEnd.publish(context);throw error})
    },
    traceCallback(fn,position=-1,context={},thisArg,...args){
      if(typeof fn!=='function')throw invalid('fn','function',fn)
      if(position<0)position=args.length+position
      const callback=args[position]
      if(typeof callback!=='function')throw invalid('callback','function',callback)
      args[position]=function(...callbackArgs){
        const [error,result]=callbackArgs
        if(error){context.error=error;channels.error.publish(context)}else context.result=result
        channels.asyncStart.publish(context)
        try{return Reflect.apply(callback,this,callbackArgs)}finally{channels.asyncEnd.publish(context)}
      }
      channels.start.publish(context)
      try{return Reflect.apply(fn,thisArg,args)}catch(error){context.error=error;channels.error.publish(context);throw error}finally{channels.end.publish(context)}
    }
  })
}

export default {Channel,channel,hasSubscribers,subscribe,unsubscribe,tracingChannel}
