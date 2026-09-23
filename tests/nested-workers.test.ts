import {it,expect} from 'vitest'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {GuestProcesses,type ProcessInput} from '../src/sandbox/guest-processes'
const result={exitCode:0,stdout:'',stderr:'',duration:0,wasmHeapBytes:0}
it('nested termination cascades, ownership stays direct-parent-only, and capacity recovers',async()=>{
 const processes=new GuestProcesses(record=>new Promise(resolve=>{if(record.controller.signal.aborted)resolve(result);else record.controller.signal.addEventListener('abort',()=>resolve(result),{once:true})}))
 const input=(worker=false):ProcessInput=>({code:'',argv:[],options:{},...(worker?{worker:{threadId:0,data:'null'}}:{})})
 const root=processes.start(0,input()),middle=processes.start(root.pid,input(true)),leaf=processes.start(middle.pid,input(true))
 expect(()=>processes.get(root.pid,leaf.pid)).toThrow()
 expect(new Set([root.pid,middle.pid,leaf.pid]).size).toBe(3)
 await Promise.resolve();processes.kill(0,root.pid)
 await Promise.all([root.result,middle.result,leaf.result])
 expect(processes.active).toHaveLength(0);expect(middle.signal).toBe('SIGKILL');expect(leaf.signal).toBe('SIGKILL')
 const restart=processes.start(0,input());await Promise.resolve();processes.kill(0,restart.pid);await restart.result
 expect(processes.active).toHaveLength(0)
})
it('native nested workers preserve isolation, ALS boundaries and stream routing',()=>{
 const native=spawnSync(process.execPath,['tests/fixtures/nested-worker-parent.mjs'],{encoding:'utf8',timeout:15000})
 expect(native.status,native.stderr).toBe(0)
 expect(JSON.parse(native.stdout)).toEqual({count:1,store:null,code:0,stdout:'middle stdout\n',middle:{count:1,store:'middle-store',isMainThread:false,code:0,stdout:'leaf stdout\n',stderr:'leaf stderr\n'},leaf:{answer:42,count:1,store:null,isMainThread:false,distinctThread:true}})
})
it('worker resource limits reject unsupported settings instead of silently accepting them',()=>{
 const source=readFileSync('src/sandbox/guest-worker-threads.js','utf8')
 const body=source.slice(source.indexOf('function workerOptions('),source.indexOf('\nclass TransportPort'))
 const normalize=new Function('process','SHARE_ENV','unsupported',body+';return workerOptions')(process,Symbol(),(message:string)=>Object.assign(Error(message),{code:'ERR_UNSUPPORTED_OPERATION'}))
 for(const value of [null,42,[],true])expect(()=>normalize({resourceLimits:value})).toThrow(TypeError)
 expect(()=>normalize({resourceLimits:{maxOldGenerationSizeMb:16}})).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
 expect(()=>normalize({resourceLimits:{}})).not.toThrow()
 expect(()=>normalize({workerMaxBytes:64*1024*1024})).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
it('nested workers cannot bypass the shared process count limit',async()=>{
 const processes=new GuestProcesses(record=>new Promise(resolve=>{if(record.controller.signal.aborted)resolve(result);else record.controller.signal.addEventListener('abort',()=>resolve(result),{once:true})}))
 const records=[processes.start(0,{code:'',argv:[],options:{}})]
 for(let index=1;index<8;index++)records.push(processes.start(records.at(-1)!.pid,{code:'',argv:[],options:{},worker:{threadId:0,data:'null'}}))
 expect(()=>processes.start(records.at(-1)!.pid,{code:'',argv:[],options:{},worker:{threadId:0,data:'null'}})).toThrow(expect.objectContaining({code:'EAGAIN'}))
 await Promise.resolve();processes.kill(0,records[0].pid);await Promise.all(records.map(record=>record.result))
 expect(processes.active).toHaveLength(0)
})
