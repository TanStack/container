import {describe,expect,it,vi} from 'vitest'
import {HOST_OPERATIONS} from '../src/sdk/host-protocol'
import {HostedKernel} from '../src/sdk/hosted-kernel'

function fixture(){
  const requests:any[]=[],targetOrigins:string[]=[],attrs=new Map<string,string>()
  let load:()=>void=()=>{},removed=false
  const container:any={append:vi.fn(()=>queueMicrotask(load))}
  const frame:any={hidden:false,tabIndex:0,src:'',referrerPolicy:'',style:{},contentWindow:{postMessage(message:any,targetOrigin:string,transfer:MessagePort[]){
    targetOrigins.push(targetOrigin);expect(message).toMatchObject({type:'browser-sandbox-host:attach',protocolVersion:1,ownerOrigin:'https://owner.test'})
    const port=transfer[0];port.start();port.postMessage({type:'attached',protocolVersion:1,nonce:message.nonce,capabilities:{protocolVersion:1,buildId:'build',apiVersion:5,crossOriginIsolated:true,sharedArrayBuffer:true,indexedDB:true,operations:HOST_OPERATIONS}})
    port.onmessage=event=>{
      const request=event.data;requests.push(request)
      if(request.type!=='request')return
      if(request.operation==='kernel.execute')port.postMessage({type:'output',requestId:request.id,level:'log',text:'hi'})
      const values:Record<string,unknown>={
        'kernel.readFile':request.args[1]==='utf8'?'text':new Uint8Array([1,2]),
        'kernel.install':{installed:[],packageCount:0},'kernel.resources':{ok:true},
        'kernel.execute':{exitCode:0,stdout:'',stderr:'',duration:1,wasmHeapBytes:1},
        'kernel.spawn':{handle:7,pid:42},'kernel.spawnShell':{handle:10,pid:43},'process.next':{type:'stdout',bytes:new Uint8Array([1])},'process.wait':{exitCode:0,stdout:'',stderr:'',duration:1,wasmHeapBytes:1,signal:null},'process.kill':true,
        'kernel.connect':{handle:8,port:5000,remotePort:4173},'socket.read':{type:'data',bytes:new Uint8Array([2])},
        'kernel.openFileSession':{handle:9},'file.call':'file-result','kernel.saveCheckpoint':{key:'saved'},'kernel.checkpointMetadata':undefined,'kernel.deleteCheckpoint':true,
        'preview.inspect':{title:'App',text:'Ready',controls:[],url:'https://preview.test/'},'preview.click':{title:'App',text:'Clicked',controls:[],url:'https://preview.test/'},
      }
      port.postMessage({type:'result',id:request.id,value:values[request.operation]})
    }
  }},setAttribute(name:string,value:string){attrs.set(name,value)},removeAttribute(name:string){attrs.delete(name)},addEventListener(type:string,listener:()=>void){if(type==='load')load=listener},remove(){removed=true}}
  const document:any={location:{origin:'https://owner.test'},baseURI:'https://owner.test/app',createElement:()=>frame,body:{append(){queueMicrotask(load)}},documentElement:{append(){}}}
  frame.ownerDocument=document
  return {document,frame,container,requests,targetOrigins,attrs,removed:()=>removed}
}

describe('HostedKernel',()=>{
  it('loads an exact-origin host and exposes the kernel, process, socket, file and shutdown surface',async()=>{
    const f=fixture();f.frame.parentElement=f.container
    const kernel=await HostedKernel.create({'/a':'a'},{hostURL:'https://host.test/runtime',document:f.document,container:f.container,expectedBuildId:'build'})
    expect(f.targetOrigins).toEqual(['https://host.test']);expect(f.frame.src).toContain('ownerOrigin=https%3A%2F%2Fowner.test');expect(f.attrs.get('sandbox')).toBe('allow-scripts allow-same-origin');expect(f.attrs.get('allow')).toBe('cross-origin-isolated');expect(f.frame.referrerPolicy).toBe('no-referrer');expect(f.frame.hidden).toBe(false);expect(f.frame.style).toMatchObject({width:'100%',height:'100%',pointerEvents:'auto'})
    expect(await kernel.readText('/a')).toBe('text');await kernel.writeText('/b','b')
    const output=vi.fn();expect((await kernel.execute('1',{onOutput:output})).exitCode).toBe(0);expect(output).toHaveBeenCalledWith('log','hi')
    await kernel.install({});expect(await kernel.resources()).toEqual({ok:true})
    const child=await kernel.spawn('node',['a']);expect(child.pid).toBe(42);expect(await child.next()).toMatchObject({type:'stdout'});await child.write('input');await child.end();expect(await child.kill()).toBe(true);await child.wait();await child.dispose()
    const shell=await kernel.spawnShell('node a');expect(shell.pid).toBe(43);await shell.dispose()
    const socket=await kernel.connect(4173);expect(socket).toMatchObject({port:5000,remotePort:4173});await socket.read();await socket.write(new Uint8Array([1]));await socket.end();await socket.close()
    const file=await kernel.openFileSession({writable:true});expect(await file.call('stat',['/a'])).toBe('file-result');await file.close()
    const preview=await kernel.mountPreview(f.container,{origin:'https://preview.test',port:4173})
    expect(f.container.append).toHaveBeenCalledWith(f.frame);expect(f.frame.style).toMatchObject({width:'100%',height:'100%',pointerEvents:'auto'});expect((await preview.inspect()).text).toBe('Ready');expect((await preview.click('button')).text).toBe('Clicked');await preview.close()
    expect(f.frame.style).toMatchObject({width:'100%',height:'100%',pointerEvents:'auto'})
    expect((await kernel.saveCheckpoint('saved')).key).toBe('saved');expect(await kernel.checkpointMetadata('saved')).toBeUndefined();expect(await kernel.deleteCheckpoint('saved')).toBe(true)
    kernel.close();await kernel.shutdown;expect(f.removed()).toBe(true)
    expect(f.requests.map(request=>request.operation)).toContain('kernel.close')
  })
  it('rejects opaque owners and non-http hosts before attachment',async()=>{
    const f=fixture();f.document.location.origin='null'
    await expect(HostedKernel.create({},{hostURL:'https://host.test',document:f.document})).rejects.toThrow('non-opaque')
    f.document.location.origin='https://owner.test'
    await expect(HostedKernel.create({},{hostURL:'data:text/html,hi',document:f.document})).rejects.toThrow('HTTPS or loopback HTTP')
    await expect(HostedKernel.create({},{hostURL:'http://remote.test',document:f.document})).rejects.toThrow('HTTPS or loopback HTTP')
    await expect(HostedKernel.create({},{hostURL:'https://owner.test/host',document:f.document})).rejects.toThrow('dedicated cross-origin')
  })
  it('supports forceful disconnect without leaving shutdown pending',async()=>{
    const f=fixture(),kernel=await HostedKernel.create({},{hostURL:'https://host.test/runtime',document:f.document})
    kernel.disconnect();await kernel.shutdown
    expect(f.removed()).toBe(true)
    await expect(kernel.resources()).rejects.toThrow('Kernel client closed')
  })
})
