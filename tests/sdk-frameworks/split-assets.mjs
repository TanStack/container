import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {verifyDeploymentAssets} from '../../scripts/sdk-external-assets.mjs'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
export function strictSDKFile(sdk,deployment,relative){
  const runtime=deployment&&relative.startsWith('runtime/')
  const base=runtime?deployment:sdk,file=realpathSync(resolve(base,relative))
  if(!file.startsWith(realpathSync(base)+sep))throw Error('outside package')
  return file
}

/** Use the installed public setup export; never synthesize a monolithic SDK. */
export async function prepareStrictSplitAssets(sdk,runtime){
  if(!runtime)return undefined
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'sdk-strict-split-'))),consumer=join(directory,'consumer')
  mkdirSync(consumer);writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'sdk-strict-consumer',private:true,type:'module'}))
  const env={...process.env,npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}
  const npm=(args,cwd=directory)=>execFileSync('npm',args,{cwd,env,encoding:'utf8',timeout:120000})
  const tarballs=[sdk,runtime].map(root=>{
    const packed=JSON.parse(npm(['pack',root,'--json','--ignore-scripts','--pack-destination',directory]))
    assert.equal(packed.length,1)
    return join(directory,packed[0].filename)
  })
  npm(['install','--ignore-scripts','--no-audit','--no-fund',...tarballs],consumer)
  const require=createRequire(join(consumer,'package.json'))
  const assets=await import(pathToFileURL(require.resolve('@tanstack/browser-sandbox-experimental/assets')))
  const prepared=await assets.prepareRuntimeAssets(join(consumer,'deployed'))
  const deploymentBytes=readFileSync(prepared.manifestPath),deployment=JSON.parse(deploymentBytes)
  const manifestBytes=readFileSync(join(sdk,'package-assets.json')),runtimeBytes=readFileSync(join(runtime,'package-assets.json'))
  verifyDeploymentAssets(prepared.directory,deployment,{packageManifestSHA256:hash(runtimeBytes),expectedFiles:deployment.files})
  const profile=assets.readRuntimeProfileManifest()
  return {
    directory:prepared.directory,previewHostDirectory:prepared.previewHostDirectory,
    evidence:{packaging:'split',manifestSHA256:hash(manifestBytes),runtimeManifestSHA256:hash(runtimeBytes),tarballSHA256:hash(readFileSync(tarballs[0])),runtimeTarballSHA256:hash(readFileSync(tarballs[1])),deploymentManifestSHA256:hash(deploymentBytes)},
    manifest:{...profile,files:deployment.files},
  }
}
