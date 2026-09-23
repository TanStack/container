import {mkdtempSync,cpSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

export async function startPackagedFrameworkDiagnostic(prefix){
  const sdk=resolve(process.env.SDK_OUTPUT),directory=mkdtempSync(join(tmpdir(),prefix))
  cpSync(join(sdk,'examples/frameworks'),join(directory,'example'),{recursive:true})
  const env={...process.env,npm_config_cache:join(directory,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}
  const packed=JSON.parse(execFileSync('npm',['pack',sdk,'--json','--ignore-scripts','--pack-destination',directory],{encoding:'utf8',env,timeout:30000}))
  if(packed.length!==1)throw Error('Expected one packed SDK')
  const tarball=join(directory,packed[0].filename)
  execFileSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',tarball],{cwd:join(directory,'example'),env,timeout:30000})
  const {startExample}=await import(pathToFileURL(join(directory,'example/server.mjs')).href)
  const host=await startExample({ownerPort:0,previewPort:0})
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
  return {host,evidence:{sdk,directory,tarballSHA256:hash(tarball),manifestSHA256:hash(join(sdk,'manifest.json'))}}
}
