(() => {
  const read=globalThis.__readWorkspaceAsset;
  const readExternal=globalThis.__readExternalAsset;
  delete globalThis.__readWorkspaceAsset;
  delete globalThis.__readExternalAsset;
  const Request=globalThis.Request,Response=globalThis.Response,ReadableStream=globalThis.ReadableStream;
  globalThis.fetch=async function fetch(input,init){
    const request=new Request(input,init),signal=request.signal;
    signal.throwIfAborted();
    await 0;
    signal.throwIfAborted();
    const url=new URL(request.url);
    const workspace=(url.protocol==='file:'&&!url.host)||(url.protocol==='https:'&&url.origin==='https://workspace.invalid');
    if(workspace&&!read)throw new TypeError('Workspace fetch is not enabled');
    if(!workspace&&!readExternal)throw new TypeError('External fetch is not enabled');
    const headers=Object.fromEntries(request.headers);
    const {metadata,bytes}=workspace?read(request.url,request.method):await readExternal(request.url,request.method,JSON.stringify(headers));
    const options=JSON.parse(metadata);
    if(bytes===null)return new Response(null,options);
    let data=new Uint8Array(bytes),offset=0;
    const cleanup=()=>{signal.removeEventListener('abort',abort);data=null};
    let controller;
    const abort=()=>{controller.error(signal.reason);cleanup()};
    const body=new ReadableStream({
      start(value){controller=value;signal.addEventListener('abort',abort,{once:true})},
      pull(value){
        if(offset===data.length){value.close();cleanup();return}
        const end=Math.min(offset+65536,data.length);
        value.enqueue(data.subarray(offset,end));offset=end;
      },
      cancel(){cleanup()},
    },{highWaterMark:0});
    return new Response(body,options);
  };
})();
