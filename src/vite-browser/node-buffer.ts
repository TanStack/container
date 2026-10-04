import {Buffer} from 'buffer'

let installed=false

/** Add Node's base64url encoding to the browser Buffer polyfill. */
export function installBufferBase64Url():void{
  if(installed)return
  installed=true
  const originalFrom=Buffer.from
  Buffer.from=((value:unknown,encodingOrOffset?:unknown,length?:number)=>{
    if(typeof value==='string'&&encodingOrOffset==='base64url'){
      const base64=value.replaceAll('-','+').replaceAll('_','/')
      return originalFrom(base64+'='.repeat((4-base64.length%4)%4),'base64')
    }
    return Reflect.apply(originalFrom,Buffer,[value,encodingOrOffset,length])
  }) as typeof Buffer.from
  const originalToString=Buffer.prototype.toString
  Buffer.prototype.toString=function(encoding?:BufferEncoding,start?:number,end?:number){
    if(encoding==='base64url'){
      return originalToString.call(this,'base64',start,end)
        .replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
    }
    return originalToString.call(this,encoding,start,end)
  }
}
