const failure=(code:string,message:string)=>Object.assign(new Error(message),{code})

/** Decode JavaScript data modules without giving them a workspace-relative base. */
export function dataModuleSource(specifier:string):string{
  const url=new URL(specifier)
  if(url.protocol!=='data:')throw failure('ERR_INVALID_URL','Expected a data URL')
  const match=/^([^,]*?),(.*)$/s.exec(url.pathname)
  if(!match)throw failure('ERR_INVALID_URL','Invalid data URL')
  const metadata=match[1],mime=metadata.split(';')[0].toLowerCase()
  if(mime!=='text/javascript'&&mime!=='application/javascript')throw failure('ERR_UNKNOWN_MODULE_FORMAT','Unsupported data module MIME type: '+mime)
  const escaped=match[2],bytes:number[]=[]
  for(let i=0;i<escaped.length;){
    if(escaped[i]==='%'&&/^[0-9a-f]{2}$/i.test(escaped.slice(i+1,i+3))){bytes.push(parseInt(escaped.slice(i+1,i+3),16));i+=3}
    else{const point=escaped.codePointAt(i)!;bytes.push(...new TextEncoder().encode(String.fromCodePoint(point)));i+=point>65535?2:1}
  }
  if(/;base64$/i.test(metadata)){
    const binary=atob(new TextDecoder().decode(new Uint8Array(bytes)))
    return new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0)))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
