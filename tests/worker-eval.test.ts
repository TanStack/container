import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const source=readFileSync('src/sandbox/guest-worker-threads.js','utf8')
const optionsSource=source.slice(source.indexOf('function workerOptions('),source.indexOf('\nclass TransportPort'))
const normalize=new Function('process','SHARE_ENV','unsupported',optionsSource+';return workerOptions')(process,Symbol(),(feature:string)=>Object.assign(Error(feature),{code:'ERR_UNSUPPORTED_OPERATION'}))
it('normalizes explicit eval modes and rejects ambiguous or unrelated flags',()=>{
 for(const mode of ['commonjs','module'])expect(normalize({eval:true,execArgv:['--input-type='+mode]})).toMatchObject({eval:true,execArgv:['--input-type='+mode]})
 for(const options of [{eval:true},{eval:true,execArgv:[]},{eval:true,execArgv:['--inspect']},{eval:true,execArgv:['--input-type=module','--inspect']},{execArgv:['--input-type=module']}]){
  expect(()=>normalize(options)).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
 }
 expect(()=>normalize({eval:'true'})).toThrow(TypeError)
 expect(normalize({})).toMatchObject({eval:false,execArgv:[]})
})
it('checks the eval fixture against native Node before browser acceptance',()=>{
 const native=spawnSync(process.execPath,['tests/fixtures/worker-eval-parent.mjs'],{encoding:'utf8',timeout:15000})
 expect(native.status,native.stderr).toBe(0)
 const result=JSON.parse(native.stdout)
 for(const mode of ['commonjs','module'])expect(result[mode]).toEqual({online:true,code:0,message:{answer:42,isMainThread:false,requireType:mode==='commonjs'?'function':'undefined',execArgv:['--input-type='+mode],args:['fixture-arg']}})
 expect(result.throw).toEqual({code:1,error:{name:'Error',message:'eval fixture failure'}})
 expect(result['invalid-commonjs']).toEqual({code:1,error:{name:'SyntaxError'}})
})
