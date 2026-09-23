import {test,expect} from 'vitest'
import * as native from 'node:util'
import source from '../src/sandbox/guest-style-text.js?raw'

test('styleText matches Node styles, nested closing codes and validation',()=>{
  const util={inspect:native.inspect}
  const style=new Function('util','process',source.replace('export function','function')+';return styleText')(util,{stdout:process.stdout,env:{}})
  const result=(fn:Function,args:unknown[])=>{try{return fn(...args)}catch(error){return {code:(error as any).code}}}
  for(const format of [...Object.getOwnPropertyNames(native.inspect.colors),'none',[],['bold','red'],['dim','bold'],'missing',42,null]){
    for(const text of ['hello','a\x1b[39mb','a\x1b[22mb','',42]){
      const args=[format,text,{validateStream:false}]
      expect(result(style,args),JSON.stringify(args)).toEqual(result(native.styleText,args))
    }
  }
  for(const options of [null,42,[],{validateStream:'yes'},{stream:{}},{validateStream:true,stream:process.stdout}]){
    const args=['red','text',options]
    expect(result(style,args)).toEqual(result(native.styleText,args))
  }
})
