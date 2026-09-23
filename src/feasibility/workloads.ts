import {WorkerKernel} from '../sandbox/kernel'
import type {ExecutionResult} from '../sandbox/process'
import {compile} from '../sandbox/compile'

interface Reference {status:string;value?:unknown;stderr?:string;reason?:string}
export interface Workload {
  id:string;group:string;scope:string;adaptation:string|null
  execution?:'bundle'|'modules'
  reference:Reference;editedReference:Reference
  preparation:{status:string;error?:string;sha256?:string;asset?:string;bytes?:number;fileCount?:number}
}
export interface WorkloadManifest {
  schema:number;node:string;lockSHA256:string;packages:Record<string,string>;preparation:string;cases:Workload[]
}
export interface WorkloadResult {
  id:string;scope:string;adaptation:string|null;status:'pass'|'adapted-pass'|'gap'|'fixture-error'|'preparation-blocked'
  execution:'bundle'|'modules'
  stage:string;error?:string;durationMs:number;iterations:{name:string;execution:ExecutionResult;value:unknown}[]
  recovery?:ExecutionResult;userAgent:string
}
export async function workloadManifest():Promise<WorkloadManifest>{
  const response=await fetch('/workloads/manifest.json',{cache:'no-store'})
  if(!response.ok)throw Error('Run npm run prepare:workloads first')
  return response.json()
}
export async function runWorkload(id:string,manifest?:WorkloadManifest,options:{guestWasm?:boolean}={}):Promise<WorkloadResult>{
  manifest??=await workloadManifest()
  const fixture=manifest.cases.find(row=>row.id===id)
  if(!fixture)throw Error('Unknown workload: '+id)
  const started=performance.now()
  const result:WorkloadResult={id,scope:fixture.scope,adaptation:fixture.adaptation,execution:fixture.execution??'bundle',status:'gap',stage:'preparation',
    durationMs:0,iterations:[],userAgent:navigator.userAgent}
  let kernel:WorkerKernel|undefined
  try{
    if(fixture.reference.status==='error'||fixture.editedReference.status==='error'){
      result.status='fixture-error';result.error='Node reference failed: '+(fixture.reference.stderr??fixture.editedReference.stderr);return result
    }
    if(fixture.preparation.status!=='ready'){
      result.status='preparation-blocked';result.error=fixture.preparation.error;return result
    }
    if((fixture.preparation.bytes??0)>32*1024*1024){
      result.stage='workspace';result.error=`Source graph is ${fixture.preparation.bytes} bytes, above the kernel's 33554432-byte workspace quota`;return result
    }
    const response=await fetch('/workloads/'+(fixture.preparation.asset??id+'.json'))
    if(!response.ok)throw Error('Missing workload source graph')
    const text=await response.text()
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('')
    if(digest!==fixture.preparation.sha256)throw Error('Stale workload source graph')
    const graph=JSON.parse(text) as {files:Record<string,{base64:string}>}
    const files=Object.fromEntries(Object.entries(graph.files).map(([path,file])=>[path,Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))]))
    result.stage='workspace'
    kernel=new WorkerKernel(files)
    await kernel.snapshot()
    for(const [name,seed,reference] of [
      ['initial',3,fixture.reference],['edited',7,fixture.editedReference],
      ['repeat',7,fixture.editedReference],['restored',3,fixture.reference],
    ] as const){
      await kernel.writeText('/input.json',JSON.stringify({value:seed}))
      result.stage='compile:'+name
      const bundle=fixture.execution==='modules'?undefined:await compile(await kernel.snapshot(),'/main.mjs',new AbortController().signal,{compact:true})
      result.stage='execute:'+name
      const settings={webAPIs:true,maxBytes:64*1024*1024,timeoutMs:10000,guestWasm:options.guestWasm}
      const execution=bundle?await kernel.execute(bundle.code,settings):await kernel.runModule('/main.mjs',settings)
      const lines=execution.stdout.split('\n').filter(line=>line.startsWith('__WORKLOAD_RESULT__'))
      const value=lines.length===1?JSON.parse(lines[0].slice('__WORKLOAD_RESULT__'.length)):null
      result.iterations.push({name,execution,value})
      if(execution.exitCode!==0)throw Error(execution.stderr)
      if(lines.length!==1)throw Error('Expected exactly one result, received '+lines.length)
      if(reference.status!=='pass'){
        result.status='fixture-error';throw Error('Node reference unavailable: '+(reference.stderr??reference.reason??reference.status))
      }
      if(JSON.stringify(value)!==JSON.stringify(reference.value))throw Error('Output mismatch: '+JSON.stringify({expected:reference.value,actual:value}))
    }
    result.status=fixture.adaptation?'adapted-pass':'pass';result.stage='complete'
  }catch(error){
    result.error=String(error)
    if(result.stage==='preparation')result.status='fixture-error'
    if(kernel){
      try{result.recovery=await kernel.execute('console.log(42)',{timeoutMs:1000,guestWasm:options.guestWasm})}catch{/* A closed/failed owner is itself evidence. */}
    }
  }finally{
    kernel?.close()
    result.durationMs=performance.now()-started
  }
  return result
}
export async function runWorkloads(onProgress:(result:WorkloadResult)=>void=()=>{}){
  const manifest=await workloadManifest(),results:WorkloadResult[]=[]
  for(const fixture of manifest.cases){
    const result=await runWorkload(fixture.id,manifest)
    results.push(result);onProgress(result)
  }
  return {generatedAt:new Date().toISOString(),backend:'worker-kernel',manifest,results}
}
