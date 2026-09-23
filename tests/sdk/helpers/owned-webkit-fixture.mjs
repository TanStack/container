import {dirname} from 'node:path'
import {processSnapshot,sampleOwnedWebKit,currentWorkerOwner} from './owned-webkit-sample.mjs'

const ownership=new WeakMap()
export const ownedProfileEnabled=process.env.SDK_OWNED_PROFILE==='1'
export const standardProfileEnabled=process.env.SDK_STANDARD_PROFILE==='1'
if(ownedProfileEnabled&&standardProfileEnabled)throw Error('SDK_OWNED_PROFILE and SDK_STANDARD_PROFILE cannot be combined')
const standardOwnership=new WeakMap()

// Called in beforeEach, without replacing or wrapping any Playwright fixture.
export async function captureStandardWebKitOwnership(browser,playwright,browserName){
  if(!standardProfileEnabled||browserName!=='webkit')return
  let owner,unavailable
  try{owner=await currentWorkerOwner()}catch(error){unavailable=String(error)}
  standardOwnership.set(browser,{owner,unavailable,bundleRoot:dirname(playwright.webkit.executablePath())})
}
export async function standardWebKitEvidence(browser,failed){
  if(!standardProfileEnabled)return undefined
  const owned=standardOwnership.get(browser)
  if(!owned)return {diagnosticOnly:true,mode:'standard-worker',unavailable:'This browser has no captured standard WebKit worker ownership'}
  return {diagnosticOnly:true,mode:'standard-worker',anchor:owned.owner?.anchor,ownershipUnavailable:owned.unavailable,
    ...(failed&&owned.owner?{profile:await sampleOwnedWebKit(owned.owner,owned.bundleRoot)}:{sampling:failed?'Unavailable worker ownership':'Not requested because the workflow passed'})}
}

export function withOwnedWebKitProfile(base){
  if(!ownedProfileEnabled)return base
  return base.extend({
    // Match the installed Playwright worker-scoped browser fixture. Context and
    // page fixtures remain untouched, including their defaults and teardown.
    browser:[async({playwright,browserName,_browserOptions,connectOptions},use)=>{
      if(browserName!=='webkit'){
        const browser=connectOptions
          ?await playwright[browserName].connect(connectOptions.wsEndpoint,connectOptions)
          :await playwright[browserName].launch()
        try{await use(browser)}finally{await browser.close({reason:'Test ended.'})}
        return
      }
      if(connectOptions)throw Error('Owned WebKit diagnostic requires a locally launched browser')
      const server=await playwright.webkit.launchServer(_browserOptions)
      let browser
      try{
        const child=server.process()
        let anchor,unavailable
        try{
          anchor=(await processSnapshot()).find(row=>row.pid===child.pid)
          if(!anchor)unavailable='Browser PID was absent from process snapshot'
        }catch(error){unavailable=String(error)}
        browser=await playwright.webkit.connect(server.wsEndpoint())
        ownership.set(browser,{child,anchor,unavailable,bundleRoot:dirname(playwright.webkit.executablePath())})
        await use(browser)
      }finally{
        try{await browser?.close({reason:'Test ended.'})}finally{await server.close()}
      }
    },{scope:'worker',timeout:0}],
  })
}

export async function ownedWebKitEvidence(browser,failed){
  if(!ownedProfileEnabled)return undefined
  const owned=ownership.get(browser)
  if(!owned)return {diagnosticOnly:true,unavailable:'This browser is not an owned diagnostic WebKit instance'}
  return {
    diagnosticOnly:true,anchor:owned.anchor,ownershipUnavailable:owned.unavailable,
    ...(failed?{profile:await sampleOwnedWebKit({kind:'child',child:owned.child,anchor:owned.anchor},owned.bundleRoot)}:{sampling:'Not requested because the workflow passed'}),
  }
}
