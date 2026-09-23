import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const source=readFileSync('src/sandbox/guest-worker-threads.js','utf8')
const helper=source.slice(source.indexOf('const transferBuffer='),source.indexOf('function workerOptions('))
const api=new Function('unsupported','routedPorts',helper+';return {transferList,detachTransferred}')((text:string)=>Object.assign(Error(text),{code:'ERR_UNSUPPORTED_OPERATION'}),{isPort:()=>false})
it('detaches every sender alias using the engine intrinsic, rejects invalid lists without detachment',()=>{
 const buffer=new ArrayBuffer(4),view=new Uint8Array(buffer)
 expect(()=>api.transferList([buffer,buffer])).toThrow(expect.objectContaining({name:'DataCloneError'}))
 expect(buffer.byteLength).toBe(4)
 const accepted=api.transferList([buffer]);expect(buffer.byteLength).toBe(4)
 api.detachTransferred(accepted);expect(buffer.byteLength).toBe(0);expect(view.byteLength).toBe(0)
 expect(()=>api.transferList([buffer])).toThrow(expect.objectContaining({name:'DataCloneError'}))
 expect(()=>api.transferList([new Uint8Array(1)])).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
it('native Worker bootstrap and messages transfer bytes and preserve receiving aliases',()=>{
 const run=spawnSync(process.execPath,['tests/fixtures/worker-transfer-parent.mjs'],{encoding:'utf8',timeout:15000})
 expect(run.status,run.stderr).toBe(0)
 expect(JSON.parse(run.stdout)).toEqual({message:{bootstrap:[7,8,9],bytes:[41,42],alias:true},detached:{bootstrap:0,alias:0,input:0,view:0},code:0})
})
