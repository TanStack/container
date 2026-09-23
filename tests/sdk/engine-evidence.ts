import {expect,type Page,type TestInfo,type Response} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {platform,release,arch} from 'node:os'

/** Observe bytes returned to the worker, rather than fetching a second control copy. */
export function observeSDKEngines(page:Page,info:TestInfo,sdkRoot:string,requiredSlot:string,additionalTrustedOrigins:string[]=[],serverLoads:{url:string;slot:string;path:string;status:number;bytes:number;sha256:string}[]=[],split?:{manifest:unknown;evidence:{manifestSHA256:string;[key:string]:string}}){
  const manifestBytes=readFileSync(resolve(sdkRoot,split?'package-assets.json':'manifest.json'))
  const manifest=(split?.manifest??JSON.parse(manifestBytes.toString('utf8'))) as {
    buildProfile?:string;engines?:unknown;files:{path:string;bytes:number;sha256:string}[]
  }
  const manifestSHA256=createHash('sha256').update(manifestBytes).digest('hex')
  if(split&&split.evidence.manifestSHA256!==manifestSHA256)throw Error('Split SDK evidence changed after preparation')
  const expected=new Map(manifest.files.map(file=>[file.path,file]))
  const errors:string[]=[],loads:{url:string;slot:string;path:string;status:number;bytes?:number;sha256?:string;expectedSHA256?:string}[]=[]
  const pending:Promise<void>[]=[]
  const context=page.context()
  const trustedOrigins=new Set([new URL(page.url()).origin,...additionalTrustedOrigins.map(value=>new URL(value).origin)])
  const observe=(response:Response)=>{
    const url=new URL(response.url())
    const match=url.pathname.match(/\/(runtime\/([^/]+)\/engine\.wasm)$/)
    if(!match)return
    const [,path,slot]=match
    const record={url:url.href,slot,path,status:response.status(),bytes:undefined as number|undefined,sha256:undefined as string|undefined,expectedSHA256:expected.get(path)?.sha256}
    loads.push(record)
    // Context response events include dedicated-worker requests across engines.
    // Keep every rejection for flush(), so event callbacks cannot hide failures.
    pending.push((async()=>{
      if(!trustedOrigins.has(url.origin))throw Error('Engine response came from outside the trusted SDK origins: '+url.href)
      const file=expected.get(path)
      if(!file)throw Error('Engine response is absent from the SDK manifest: '+path)
      if(response.status()!==200)throw Error('Engine response status '+response.status()+': '+url.href)
      const bytes=await response.body()
      record.bytes=bytes.length
      record.sha256=createHash('sha256').update(bytes).digest('hex')
      if(bytes.length!==file.bytes||record.sha256!==file.sha256)throw Error('Served engine does not match the SDK manifest: '+path)
    })().catch(error=>{errors.push(String(error))}))
  }
  context.on('response',observe)
  let flushed=false
  return {async flush(){
    if(flushed)throw Error('SDK engine evidence already flushed')
    flushed=true
    context.off('response',observe)
    await Promise.all(pending)
    for(const record of serverLoads){
      const url=new URL(record.url),file=expected.get(record.path)
      if(!trustedOrigins.has(url.origin))errors.push('Engine server observation came from outside the trusted SDK origins: '+record.url)
      else if(!file)errors.push('Engine server observation is absent from the SDK manifest: '+record.path)
      else if(record.status!==200||record.bytes!==file.bytes||record.sha256!==file.sha256)errors.push('Server-observed engine does not match the SDK manifest: '+record.path)
    }
    const observed=loads.length?loads:serverLoads
    const evidencePath=info.outputPath('sdk-engine-evidence.json')
    await writeFile(evidencePath,JSON.stringify({
      ...split?.evidence,
      environment:{
        project:info.project.name,browserName:info.project.use.browserName??null,
        browserVersion:context.browser()?.version()??null,
        platform:platform(),release:release(),architecture:arch(),
        nodeVersion:process.version,command:process.argv,
        actualSafari:false,
      },
      manifestSHA256,buildProfile:manifest.buildProfile??'legacy-default',engines:manifest.engines??null,requiredSlot,trustedOrigins:[...trustedOrigins].sort(),loads,serverLoads,errors,
    },null,2))
    await info.attach('sdk-engine-evidence.json',{path:evidencePath,contentType:'application/json'})
    expect(errors,'Actual SDK engine response verification failed').toEqual([])
    expect(observed.length,'No runtime engine response was observed').toBeGreaterThan(0)
    expect(observed.some(load=>load.slot===requiredSlot),'Required workload engine was not loaded: '+requiredSlot).toBe(true)
  }}
}
