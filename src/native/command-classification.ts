/** Commands that the native runtime executes through its own compiler paths. */
export function isNativeViteBuild(entry:string,args:readonly string[],evalSource?:string){
  return evalSource===undefined&&entry==='/app/node_modules/vite/bin/vite.js'&&args[0]==='build'&&
    (args.length===1||args.length===2&&args[1]==='--ssr'||
      args.length===3&&args[1]==='--configLoader'&&args[2]==='runner')
}

export function nativeViteDevOptions(entry:string,args:readonly string[],evalSource?:string):{host?:string|boolean}|undefined{
  if(evalSource!==undefined||entry!=='/app/node_modules/vite/bin/vite.js')return
  const flags=['dev','serve'].includes(args[0]??'')?args.slice(1):args
  let host:string|boolean|undefined
  for(let index=0;index<flags.length;index++){
    if(flags[index]==='--configLoader'&&flags[index+1]==='runner'){index++;continue}
    if(flags[index]==='--host'){
      const value=flags[index+1]
      if(value&&!value.startsWith('-')){host=value;index++}
      else host=true
      continue
    }
    return
  }
  return {host}
}

export function isNativeViteDev(entry:string,args:readonly string[],evalSource?:string){
  return nativeViteDevOptions(entry,args,evalSource)!==undefined
}

export function isNativeTypecheck(entry:string,args:readonly string[],evalSource?:string){
  return evalSource===undefined&&
    (entry==='/app/node_modules/typescript/bin/tsc'||
      entry==='/app/node_modules/@typescript/native/bin/tsc')&&
    args.length===1&&args[0]==='--noEmit'
}
