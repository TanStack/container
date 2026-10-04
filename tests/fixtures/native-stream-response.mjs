export async function probeStreamResponse(ResponseType,foreignBytes){
  const errors=[]
  for(const method of ['text','arrayBuffer','json','blob','formData','bytes']){
    const reason=Error('Body cancelled')
    const response=new ResponseType(new ReadableStream({start(controller){controller.error(reason)}}),{headers:{'content-type':'application/x-www-form-urlencoded'}})
    let same=false,reused=false
    try{await response[method]()}catch(error){same=error===reason}
    try{await response[method]()}catch(error){reused=error instanceof TypeError}
    errors.push({method,same,reused,bodyUsed:response.bodyUsed,locked:response.body.locked})
  }
  const data=new TextEncoder().encode('hello 🌍')
  const response=new ResponseType(new ReadableStream({start(controller){controller.enqueue(data.subarray(0,8));controller.enqueue(data.subarray(8));controller.close()}}),{status:201,statusText:'Created',headers:{'x-test':'yes'}})
  const clone=response.clone(),unused=!response.bodyUsed&&!clone.bodyUsed
  const texts=await Promise.all([response.text(),clone.text()])
  const empty=new ResponseType(null,{status:204})
  const emptyTexts=[await empty.text(),await empty.text()]
  const binary=[...new Uint8Array(await new ResponseType(new Uint8Array([9,1,2,9]).subarray(1,3)).arrayBuffer())]
  const form=new FormData();form.append('a','hello');form.append('a','again');form.append('file',new Blob([new Uint8Array([0,255,2])],{type:'application/octet-stream'}),'sample.bin')
  const parsed=await new ResponseType(form).formData(),file=parsed.get('file')
  const foreign=new ResponseType(new ReadableStream({start(controller){controller.enqueue(foreignBytes);controller.close()}}))
  let foreignResult
  try{foreignResult={bytes:[...await foreign.bytes()],used:foreign.bodyUsed,locked:foreign.body.locked}}catch(error){foreignResult={error:error.name}}
  const spoof=new Uint16Array([1]);Object.defineProperty(spoof,Symbol.toStringTag,{value:'Uint8Array'})
  const invalid=[]
  for(const value of ['bad',new Uint16Array([1]),spoof,{[Symbol.toStringTag]:'Uint8Array'}]){
    const body=new ResponseType(new ReadableStream({start(controller){controller.enqueue(value);controller.close()}}))
    try{await body.bytes();invalid.push({rejected:false})}catch(error){invalid.push({rejected:error instanceof TypeError,used:body.bodyUsed,locked:body.body.locked})}
  }
  const blobTypes=[]
  for(const type of ['TEXT/PLAIN; Charset=UTF-8','not valid','text/plain; foo="a b"','text/plain;foo=bar;foo=baz','application/json; X=Y','text/plain, application/json','text/html;charset=gbk;a=b, text/html;x=y','text/html;charset=gbk, x/x, text/html;x=y','text/html, cannot-parse','text/html, */*','text/plain;foo="a,b", text/plain;x=y','text/plain;charset=utf-8, text/plain;charset=gbk, text/plain','text/plain;foo="a\\",b", application/json']){
    const blob=await new ResponseType('ok',{headers:{'content-type':type}}).blob()
    blobTypes.push({type:blob.type,text:await blob.text()})
  }
  const combinedForm=[]
  for(const types of [['text/plain','application/x-www-form-urlencoded'],['application/x-www-form-urlencoded','invalid'],['application/x-www-form-urlencoded','*/*'],['application/x-www-form-urlencoded','text/plain']]){
    const body=new ResponseType('a=hello+world',{headers:types.map(type=>['content-type',type])})
    try{combinedForm.push({values:[...(await body.formData()).entries()],used:body.bodyUsed,locked:body.body.locked})}
    catch(error){combinedForm.push({error:error.name,used:body.bodyUsed,locked:body.body.locked})}
  }
  return {errors,foreign:foreignResult,invalid,blobTypes,combinedForm,clone:{unused,sameType:clone instanceof ResponseType,status:clone.status,statusText:clone.statusText,header:clone.headers.get('x-test'),texts,locked:response.body.locked,cloneLocked:clone.body.locked},empty:{texts:emptyTexts,used:empty.bodyUsed},binary,json:await new ResponseType('{"ok":true}').json(),multipart:{values:parsed.getAll('a'),name:file.name,type:file.type,bytes:[...new Uint8Array(await file.arrayBuffer())]}}
}
