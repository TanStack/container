import {createHash} from 'node:crypto'
import {readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs'
import {basename,join,resolve} from 'node:path'
import {auditSDKCandidateEvidence} from './audit-sdk-candidate-evidence.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
export const SDK_CANDIDATE_COMPATIBILITY_PATH='candidate-compatibility.json'
export const SDK_RELEASE_RECORD_PATH='release-record.json'
export const SDK_BROWSER_KEYS=['chromium','firefox','safari','playwright-webkit']
export const SDK_WORKFLOW_KEYS=['vite','start']
export const SDK_PHASE_KEYS=['cold','resume']

function emptyResults(){
  return Object.fromEntries(SDK_BROWSER_KEYS.map(browser=>[browser,
    Object.fromEntries(SDK_WORKFLOW_KEYS.map(workflow=>[workflow,
      Object.fromEntries(SDK_PHASE_KEYS.map(phase=>[phase,{status:'unverified'}]))
    ]))
  ]))
}

function readEvidence(path,manifestSHA256,buildProfile){
  if(!path)return emptyResults()
  const input=JSON.parse(readFileSync(resolve(path),'utf8'))
  if(input?.format!==1||input.manifestSHA256!==manifestSHA256||input.buildProfile!==buildProfile)throw Error('SDK compatibility evidence does not match this manifest and build profile')
  const results=emptyResults()
  for(const browser of SDK_BROWSER_KEYS)for(const workflow of SDK_WORKFLOW_KEYS)for(const phase of SDK_PHASE_KEYS){
    const supplied=input.results?.[browser]?.[workflow]?.[phase]
    if(supplied===undefined)continue
    if(!supplied||!['passed','failed','unverified'].includes(supplied.status))throw Error(`Invalid SDK compatibility evidence status: ${browser}/${workflow}/${phase}`)
    if(supplied.status==='unverified')results[browser][workflow][phase]={status:'unverified'}
    else{
      if(!Array.isArray(supplied.evidence)||supplied.evidence.length===0||supplied.evidence.some(item=>typeof item!=='string'||item.length===0))throw Error(`Verified SDK compatibility status requires evidence: ${browser}/${workflow}/${phase}`)
      results[browser][workflow][phase]={status:supplied.status,evidence:[...supplied.evidence]}
    }
  }
  return results
}

function sourceRecord(sourceArchive){
  if(!sourceArchive)return {kind:'unavailable',revision:null,archive:null}
  const path=realpathSync(resolve(sourceArchive)),bytes=readFileSync(path),sha256=hash(bytes)
  return {kind:'source-archive',revision:`sha256:${sha256}`,archive:{file:basename(path),sha256,bytes:statSync(path).size}}
}

export function writeSDKReleaseRecords(root,{evidencePath,sourceArchive,evidenceRoot}={}){
  const directory=resolve(root),manifestBytes=readFileSync(join(directory,'manifest.json'))
  const manifest=JSON.parse(manifestBytes),manifestSHA256=hash(manifestBytes),buildProfile=manifest.buildProfile??'default'
  if(evidencePath)auditSDKCandidateEvidence(directory,evidencePath,evidenceRoot??process.cwd())
  const compatibility={
    format:1,
    scope:'Exact candidate artifact only. Unverified means no explicit evidence was supplied for this exact manifest.',
    artifact:{manifest:'manifest.json',manifestSHA256,buildProfile},
    browsers:{
      chromium:{kind:'Chromium desktop'},
      firefox:{kind:'Firefox desktop'},
      safari:{kind:'Actual Safari desktop'},
      'playwright-webkit':{kind:'Playwright WebKit',notSafariEvidence:true},
    },
    workflows:{vite:{phases:['cold','resume']},start:{phases:['cold','resume']}},
    results:readEvidence(evidencePath,manifestSHA256,buildProfile),
    historicalEvidence:{document:'COMPATIBILITY.md',appliedToCandidate:false},
  }
  const compatibilityText=JSON.stringify(compatibility,null,2)+'\n'
  writeFileSync(join(directory,SDK_CANDIDATE_COMPATIBILITY_PATH),compatibilityText)
  const packageJSON=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))
  const release={
    format:1,status:'candidate',
    package:{name:packageJSON.name,version:packageJSON.version,private:packageJSON.private===true,license:packageJSON.license??null,publishAccess:packageJSON.publishConfig?.access??null},
    artifact:{manifest:'manifest.json',manifestSHA256,buildProfile},
    compatibility:{path:SDK_CANDIDATE_COMPATIBILITY_PATH,sha256:hash(compatibilityText)},
    source:sourceRecord(sourceArchive),
    publication:{published:false,registry:null,tarballSHA256:null},
  }
  writeFileSync(join(directory,SDK_RELEASE_RECORD_PATH),JSON.stringify(release,null,2)+'\n')
  return {manifestSHA256,compatibility,release}
}
