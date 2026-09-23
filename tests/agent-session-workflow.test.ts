import {afterEach,describe,expect,it,vi} from 'vitest'
import {AgentSession} from '../src/sdk/agent-session'
import {WorkspaceFiles,type WorkspaceSnapshot} from '../src/sandbox/files'
import {installProject,type ProjectInstallOptions} from '../src/npm/project'
import {npmProject} from './fixtures/npm-project'

const encoder=new TextEncoder(),decoder=new TextDecoder()

class WorkflowKernel {
  readonly files:WorkspaceFiles
  closed=false
  constructor(files:Record<string,string|Uint8Array>){this.files=new WorkspaceFiles(files)}
  async openFileSession(){
    return {
      call:async(method:string,args:unknown[])=>{
        if(method==='readdir')return this.files.readdirSync(args[0] as string,(args[1] as {recursive?:boolean})?.recursive)
        if(method==='mkdir')return this.files.mkdirSync(args[0] as string,(args[1] as {recursive?:boolean})?.recursive)
        if(method==='rm')return this.files.rmSync(args[0] as string,args[1] as {recursive?:boolean;force?:boolean})
        if(method==='rename')return this.files.renameSync(args[0] as string,args[1] as string)
        throw Error('Unsupported file-session method in workflow fixture: '+method)
      },
      close:async()=>{},
    }
  }
  async readFile(path:string){return this.files.readFileSync(path)}
  async writeFile(path:string,value:Uint8Array){this.files.writeFileSync(path,value)}
  async install(options:ProjectInstallOptions={}){return installProject(this.files,options)}
  async snapshot(){return this.files.snapshot()}
  async restore(snapshot:WorkspaceSnapshot){this.files.replace(snapshot)}
  async resources(){return {processes:{active:0,retained:0},network:{handles:0,listeners:0},datagrams:{handles:0,bound:0},fileSessions:0,executing:false,installing:false}}
  async spawn(command:string,args:string[]=[]){
    if(command!=='node')throw Error('Workflow fixture only runs node')
    const entry=args[0],source=decoder.decode(this.files.readFileSync('/project/src/add.cjs'))
    const fixed=source.includes('a + b'),dependency=this.files.existsSync('/project/node_modules/parent/index.js')
    let stdout='',stderr='',exitCode=0
    if(entry==='/project/build.cjs'){
      if(!fixed||!dependency){stderr='build prerequisites are not satisfied\n';exitCode=1}
      else {this.files.writeFileSync('/project/dist/result.txt',encoder.encode('42\n'));stdout='built dist/result.txt\n'}
    }else if(entry==='/project/test.cjs'){
      const artifact=this.files.existsSync('/project/dist/result.txt')&&decoder.decode(this.files.readFileSync('/project/dist/result.txt'))==='42\n'
      if(fixed&&dependency&&artifact)stdout='1 test passed\n'
      else {stderr='expected the built result to be 42\n';exitCode=1}
    }else throw Error('Unknown workflow entry: '+entry)
    const events=[...(stdout?[{type:'stdout' as const,bytes:encoder.encode(stdout)}]:[]),...(stderr?[{type:'stderr' as const,bytes:encoder.encode(stderr)}]:[]),{type:'exit' as const,code:exitCode,signal:null}]
    let index=0
    return {next:async()=>events[index++]??null,wait:async()=>({exitCode,signal:null}),kill:async()=>true,dispose:async()=>{}}
  }
  close(){this.closed=true;this.files.close()}
}

afterEach(()=>vi.unstubAllGlobals())

describe('AgentSession realistic workflow',()=>{
  it('edits, installs, builds, tests, checkpoints, restores, and closes an offline project',async()=>{
    const fixture=npmProject()
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(Uint8Array.from(fixture.archives[url]))))
    const projectFiles=Object.fromEntries(Object.entries(fixture.files).map(([path,value])=>['/project'+path,value]))
    const kernel=new WorkflowKernel({
      ...projectFiles,
      '/project/src/add.cjs':'module.exports = (a, b) => a - b\n',
      '/project/build.cjs':'// deterministic project build entry\n',
      '/project/test.cjs':'// deterministic project test entry\n',
    })
    const session=new AgentSession({}, {kernel:kernel as never,maxOutputBytes:4096})

    const installed=await session.call('install',{options:{cwd:'/project',ignoreScripts:true}})
    expect(installed).toMatchObject({ok:true,value:{installed:3,skippedPlatformPackages:[],ignoredScripts:[]}})
    expect(await session.call('list',{path:'/project/node_modules'})).toMatchObject({ok:true})

    expect(await session.call('run',{command:'node',args:['/project/test.cjs'],cwd:'/project'})).toMatchObject({ok:true,value:{status:1,stderr:'expected the built result to be 42\n'}})
    expect(await session.call('write',{path:'/project/src/add.cjs',text:'module.exports = (a, b) => a + b\n'})).toEqual({ok:true,value:{bytes:33}})
    expect(await session.call('run',{command:'node',args:['/project/build.cjs'],cwd:'/project'})).toMatchObject({ok:true,value:{status:0,stdout:'built dist/result.txt\n'}})
    expect(await session.call('run',{command:'node',args:['/project/test.cjs'],cwd:'/project'})).toMatchObject({ok:true,value:{status:0,stdout:'1 test passed\n'}})

    const checkpoint=await session.call('snapshot')
    expect(checkpoint.ok).toBe(true)
    if(!checkpoint.ok)throw Error('checkpoint failed')
    await session.call('write',{path:'/project/src/add.cjs',text:'module.exports = () => 0\n'})
    await session.call('remove',{path:'/project/dist'})
    expect(await session.call('run',{command:'node',args:['/project/test.cjs'],cwd:'/project'})).toMatchObject({ok:true,value:{status:1}})

    expect(await session.call('restore',{snapshot:checkpoint.value})).toEqual({ok:true,value:{restored:true}})
    expect(await session.call('read',{path:'/project/dist/result.txt'})).toEqual({ok:true,value:{text:'42\n'}})
    expect(await session.call('run',{command:'node',args:['/project/test.cjs'],cwd:'/project'})).toMatchObject({ok:true,value:{status:0,stdout:'1 test passed\n'}})
    expect(await session.call('resources')).toEqual({ok:true,value:{processes:{active:0,retained:0},network:{handles:0,listeners:0},datagrams:{handles:0,bound:0},fileSessions:0,executing:false,installing:false}})
    expect(await session.call('close')).toEqual({ok:true,value:{closed:true}})
    expect(kernel.closed).toBe(true)
    expect((await session.call('read',{path:'/project/src/add.cjs'})).ok).toBe(false)
  })
})
