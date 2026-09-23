import {describe,it,expect} from 'vitest'
import {AgentSession,AGENT_TOOL_DEFINITIONS} from '../src/sdk/agent-session'

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
class FakeKernel {
  files:Map<string,Uint8Array<ArrayBufferLike>>=new Map([['/a.txt',new TextEncoder().encode('hello')]])
  active=0;maxActive=0;closed=false;shutdown:Promise<void>|undefined
  async list(){return [...this.files.keys()].map(path=>({path,kind:'file' as const}))}
  async openFileSession(){return {call:async(method:string,args:unknown[])=>{if(method==='readdir')return [...this.files.keys()].map(value=>({name:value.slice(1),relativePath:value.slice(1),kind:'file'}));if(method==='mkdir'){this.active++;this.maxActive=Math.max(this.maxActive,this.active);await delay(5);this.active--;return}if(method==='rm'){this.files.delete(args[0] as string);return}if(method==='rename'){this.files.set(args[1] as string,this.files.get(args[0] as string)!);this.files.delete(args[0] as string);return}},close:async()=>{}}}
  async readFile(path:string){const value=this.files.get(path);if(!value)throw Object.assign(Error('missing'),{code:'ENOENT'});return value}
  async writeFile(path:string,value:Uint8Array){this.active++;this.maxActive=Math.max(this.maxActive,this.active);await delay(5);this.files.set(path,value);this.active--}
  async mkdir(){this.active++;this.maxActive=Math.max(this.maxActive,this.active);await delay(5);this.active--}
  async remove(path:string){this.files.delete(path)} async move(from:string,to:string){this.files.set(to,this.files.get(from)!);this.files.delete(from)}
  async install(){return {installed:0,skippedPlatformPackages:[],ignoredScripts:[]}}
  async snapshot(){return {version:2 as const,files:Object.fromEntries(this.files),directories:['/']}}
  async restore(snapshot:{files:Record<string,Uint8Array>}){this.files=new Map(Object.entries(snapshot.files))}
  async resources(){return {processes:{active:0,retained:0},network:{handles:0,listeners:0},datagrams:{handles:0,bound:0},fileSessions:0,executing:false,installing:false}}
  async spawn(){let next=0;return {next:async()=>next++?{type:'exit',code:0,signal:null}:{type:'stdout',bytes:new TextEncoder().encode('ok')},wait:async()=>({exitCode:0,signal:null}),kill:async()=>true,dispose:async()=>{}}}
  close(){this.closed=true;this.shutdown=Promise.resolve()}
}

describe('AgentSession',()=>{
  it('has model-agnostic schemas and JSON-safe file, process, snapshot and error results',async()=>{
    const kernel=new FakeKernel(),session=new AgentSession({}, {kernel:kernel as never,maxOutputBytes:16})
    expect(AGENT_TOOL_DEFINITIONS.map(tool=>tool.name)).toEqual(['list','read','write','mkdir','remove','move','install','run','snapshot','restore','resources','close'])
    expect(await session.call('read',{path:'/a.txt'})).toEqual({ok:true,value:{text:'hello'}})
    expect(await session.call('run',{command:'node',args:['app.js']})).toEqual({ok:true,value:{stdout:'ok',stderr:'',status:0,signal:null,truncated:false}})
    const snapshot=await session.call('snapshot');expect(snapshot.ok&&JSON.stringify(snapshot.value)).toContain('base64')
    const missing=await session.call('read',{path:'/missing'});expect(missing).toEqual({ok:false,error:{name:'Error',message:'missing',code:'ENOENT'}})
    await session.close();expect(kernel.closed).toBe(true)
  })
  it('round trips binary and legacy base64 snapshots with workspace metadata intact',async()=>{
    const raw={version:5 as const,files:{'/bin/tool':new Uint8Array([0,1,254,255])},directories:['/','/bin'],symlinks:{'/tool':'/bin/tool'},fileModes:{'/bin/tool':0o755},directoryModes:{'/':0o755,'/bin':0o700}}
    let restored:unknown,snapshotCalls=0
    const kernel={
      snapshot:async()=>{snapshotCalls++;return structuredClone(raw)},
      restore:async(value:unknown)=>{restored=structuredClone(value)},
    }
    const session=new AgentSession({}, {kernel:kernel as never})
    const binary=await session.snapshot({encoding:'binary'})
    expect(binary).toEqual(raw)
    expect(binary.files['/bin/tool']).toBeInstanceOf(Uint8Array)
    await session.restore({snapshot:structuredClone(binary)})
    expect(restored).toEqual(raw)
    const legacy=await session.snapshot()
    expect(legacy).toEqual({...raw,files:{'/bin/tool':{base64:'AAH+/w=='}}})
    await session.restore({snapshot:JSON.parse(JSON.stringify(legacy))})
    expect(restored).toEqual(raw)
    const tool=await session.call('snapshot')
    expect(tool.ok&&tool.value).toEqual(legacy)
    await expect(session.snapshot({encoding:'gzip'} as never)).rejects.toThrow("snapshot encoding must be 'base64' or 'binary'")
    expect(snapshotCalls).toBe(3)
  })
  it('rejects host paths, observes abort, and serializes mutations',async()=>{
    const kernel=new FakeKernel(),session=new AgentSession({}, {kernel:kernel as never})
    await Promise.all([session.write({path:'/one',text:'1'}),session.mkdir({path:'/two'})]);expect(kernel.maxActive).toBe(1)
    expect((await session.call('read',{path:'relative'})).ok).toBe(false)
    const controller=new AbortController();controller.abort();expect((await session.call('list',{},controller.signal)).ok).toBe(false)
  })
  it('records only completed normal lifecycle operations when telemetry is enabled',async()=>{
    const kernel=new FakeKernel(),session=new AgentSession({}, {kernel:kernel as never,telemetry:{capacity:16}})
    await session.write({path:'/new.txt',text:'new'})
    await session.run({command:'node',args:['app.js'],cwd:'/'})
    await session.snapshot()
    await session.resources()
    await session.close()
    expect(session.telemetry?.events()).toEqual([
      {sequence:1,type:'file.write',path:'/new.txt',bytes:3},
      {sequence:2,type:'process.start',command:'node',args:['app.js'],cwd:'/'},
      {sequence:3,type:'process.exit',status:0,signal:null,truncated:false},
      {sequence:4,type:'snapshot.capture',files:2,directories:1},
      {sequence:5,type:'resources.sample',processes:{active:0,retained:0},network:{handles:0,listeners:0},datagrams:{handles:0,bound:0},fileSessions:0,executing:false,installing:false},
      {sequence:6,type:'session.close'},
    ])
  })
  it('does not report a closed session until kernel shutdown is acknowledged',async()=>{
    let acknowledge!:()=>void
    class DelayedKernel extends FakeKernel {
      override close(){this.closed=true;this.shutdown=new Promise(resolve=>{acknowledge=resolve})}
    }
    const kernel=new DelayedKernel(),session=new AgentSession({}, {kernel:kernel as never})
    let settled=false
    const closing=session.close()
    void closing.then(()=>{settled=true})
    expect(kernel.closed).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    acknowledge()
    await expect(closing).resolves.toEqual({closed:true})
    expect(session.close()).toBe(closing)
  })
  it('decodes split UTF-8 independently across interleaved stdout and stderr',async()=>{
    const encoder=new TextEncoder(),out=encoder.encode('🌍'),error=encoder.encode('⚠️')
    class SplitOutputKernel extends FakeKernel {
      override async spawn(){
        const events=[
          {type:'stdout',bytes:out.subarray(0,2)},
          {type:'stderr',bytes:error.subarray(0,1)},
          {type:'stdout',bytes:out.subarray(2)},
          {type:'stderr',bytes:error.subarray(1)},
          {type:'exit',code:0,signal:null},
        ];let index=0
        return {next:async()=>events[index++],wait:async()=>({exitCode:0,signal:null}),kill:async()=>true,dispose:async()=>{}}
      }
    }
    const session=new AgentSession({}, {kernel:new SplitOutputKernel() as never})
    expect(await session.run({command:'node'})).toEqual({stdout:'🌍',stderr:'⚠️',status:0,signal:null,truncated:false})
  })
})
