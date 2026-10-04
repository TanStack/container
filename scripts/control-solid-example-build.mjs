import {mkdtempSync,mkdirSync,copyFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname,resolve,sep} from 'node:path'
import {spawnSync,execFileSync} from 'node:child_process'

const repository=resolve(process.env.ROUTER_ROOT??'/Users/tannerlinsley/GitHub/router')
const example=process.argv[2]??'start-tailwind-v4'
if(!/^start-[a-z0-9-]+$/.test(example))throw Error('Expected a Solid example directory name')
const prefix=`examples/solid/${example}/`
const files=execFileSync('git',['-C',repository,'ls-files',prefix],{encoding:'utf8'}).trim().split('\n').filter(Boolean)
if(!files.length)throw Error('No tracked example files')
const directory=mkdtempSync(join(tmpdir(),'native-solid-node-control-'))
for(const file of files){
  if(!file.startsWith(prefix))throw Error('Unexpected source path')
  const target=resolve(directory,file.slice(prefix.length))
  if(!target.startsWith(directory+sep))throw Error('Source path leaves control directory')
  mkdirSync(dirname(target),{recursive:true})
  copyFileSync(join(repository,file),target)
}
console.log(JSON.stringify({directory,example,trackedFiles:files.length,node:process.version}))
const install=spawnSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,stdio:'inherit',timeout:180000})
if(install.error)throw install.error
if(install.status!==0)throw Error('Node control dependency installation failed')
console.log(JSON.stringify({vite:JSON.parse(readFileSync(join(directory,'node_modules/vite/package.json'))).version}))
const build=spawnSync('npm',['run','build'],{cwd:directory,stdio:'inherit',timeout:180000})
if(build.error)throw build.error
console.log(JSON.stringify({directory,example,buildExit:build.status}))
process.exitCode=build.status??1
