import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

export function compareSDKAPIContracts(baseline,candidate){
  if(baseline.format!==candidate.format)throw Error('SDK API contract format changed')
  if(candidate.stability!=='experimental')throw Error('SDK API stability must remain experimental')
  const result={compatible:true,baselineApiVersion:baseline.apiVersion,candidateApiVersion:candidate.apiVersion,entrypoints:{}}
  for(const [entrypoint,previousEntry] of Object.entries(baseline.entrypoints??{})){
    const previous=previousEntry.exports??[],next=candidate.entrypoints?.[entrypoint]?.exports??[]
    const nextByName=new Map(next.map(item=>[item.name,item]))
    const removed=previous.filter(item=>!nextByName.has(item.name)).map(item=>item.name)
    const changed=previous.filter(item=>nextByName.has(item.name)&&JSON.stringify(item)!==JSON.stringify(nextByName.get(item.name))).map(item=>item.name)
    const added=next.filter(item=>!previous.some(old=>old.name===item.name)).map(item=>item.name)
    result.entrypoints[entrypoint]={added,removed,changed}
    if(removed.length||changed.length)result.compatible=false
  }
  for(const [entrypoint,nextEntry] of Object.entries(candidate.entrypoints??{}))if(!baseline.entrypoints?.[entrypoint]){
    result.entrypoints[entrypoint]={added:(nextEntry.exports??[]).map(item=>item.name),removed:[],changed:[]}
  }
  if(!result.compatible&&candidate.apiVersion===baseline.apiVersion){
    const changes=Object.entries(result.entrypoints).filter(([,item])=>item.removed.length||item.changed.length).map(([name,item])=>`${name} removed: ${item.removed.join(', ')||'none'}, changed: ${item.changed.join(', ')||'none'}`).join('; ')
    throw Error(`Breaking SDK API change requires a new apiVersion (${changes})`)
  }
  if(candidate.apiVersion<baseline.apiVersion)throw Error('SDK apiVersion moved backwards')
  return result
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==4)throw Error('Usage: node sdk-api-compare.mjs BASELINE_API_CONTRACT CANDIDATE_API_CONTRACT')
  console.log(JSON.stringify(compareSDKAPIContracts(JSON.parse(readFileSync(process.argv[2],'utf8')),JSON.parse(readFileSync(process.argv[3],'utf8'))),null,2))
}
