import {compileSourceCompletion} from './source-completion'

/** Capture Script completion without wrapping the program in a function. */
export function compileClassicScriptCompletion(source:string,filename:string,channelKey:string){
  return compileSourceCompletion(source,filename,channelKey)
}

export function createClassicScriptCompletionChannel(){
  let value:unknown
  const saved=new Map<number,unknown>()
  return {
    get value(){return value},
    set(next:unknown){value=next;return next},
    reset(){value=undefined},
    save(id:number){saved.set(id,value);value=undefined},
    restore(id:number){value=saved.get(id);saved.delete(id)},
  }
}
