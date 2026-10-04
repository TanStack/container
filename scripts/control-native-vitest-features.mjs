import {readFile,writeFile,realpath,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const directory=await realpath(process.argv[2]??'')
if(!directory.startsWith('/private/tmp/container-vitest5-inspect-'))throw Error('Expected an owned Vitest5 control directory')
const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
if(manifest.name!=='container-vitest5-control'||manifest.devDependencies?.vitest!=='5.0.3')
  throw Error('Unexpected control manifest')
const source=await readFile('tests/fixtures/native-vitest-features.mjs')
for(const [name,contents] of [['features.test.js',source],['feature-value.js','export const answer=-1'],
  ['output-probe.js',await readFile('tests/fixtures/native-output-worker.mjs')]]){
  const path=join(directory,name)
  const existing=await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
  if(existing)throw Error(`Refusing to replace existing control file: ${path}`)
  await writeFile(path,contents,{flag:'wx'})
}
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','features.test.js'],{
  cwd:directory,encoding:'utf8',timeout:30_000,
})
console.log(JSON.stringify({directory,sourceSHA256:createHash('sha256').update(source).digest('hex'),
  exitCode:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error&&String(result.error)}))
process.exitCode=result.status??1
