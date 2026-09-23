import {mkdtemp,mkdir,readFile,readlink,realpath,rm,writeFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {createServer} from 'vite'

const run=(command,args,cwd)=>new Promise((done,reject)=>{
  const child=spawn(command,args,{cwd,env:{...process.env,npm_config_audit:'false',npm_config_fund:'false'},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',chunk=>stdout+=chunk)
  child.stderr.on('data',chunk=>stderr+=chunk)
  child.on('error',reject)
  child.on('close',code=>code===0?done(stdout):reject(Error(command+' exited '+code+'\n'+stderr)))
})
const put=async(root,path,value)=>{const file=resolve(root,path);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,value)}
const root=await mkdtemp(resolve(tmpdir(),'web-container-monorepo-native-'))
let server
try{
  await put(root,'package.json',JSON.stringify({name:'native-workspace-root',private:true,workspaces:['packages/*']}))
  await put(root,'packages/shared/package.json',JSON.stringify({name:'@graph/shared',version:'1.0.0',type:'module',exports:'./index.js',bin:{'workspace-log':'cli.cjs'},scripts:{install:'workspace-log shared'}}))
  await put(root,'packages/shared/index.js','export const value=40\n')
  await put(root,'packages/shared/cli.cjs',`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.INIT_CWD+'/lifecycle-order',process.argv.at(-1)+'\\n')\n`)
  await put(root,'packages/app/package.json',JSON.stringify({name:'@graph/app',version:'1.0.0',type:'module',dependencies:{'@graph/shared':'*'},scripts:{install:'workspace-log app'}}))
  await put(root,'packages/app/index.js',`import {value} from '@graph/shared';console.log(value+2)\n`)
  await put(root,'packages/app/src/main.js',`import {value} from '@graph/shared';document.body.textContent=String(value+2)\n`)
  await put(root,'packages/app/index.html','<script type="module" src="/src/main.js"></script>')
  await run('npm',['install','--offline','--no-audit','--no-fund'],root)
  const first=(await run(process.execPath,['packages/app/index.js'],root)).trim()
  await put(root,'packages/shared/index.js','export const value=50\n')
  const edited=(await run(process.execPath,['packages/app/index.js'],root)).trim()
  const binTarget=await readlink(resolve(root,'node_modules/.bin/workspace-log'))
  const lifecycle=(await readFile(resolve(root,'lifecycle-order'),'utf8')).trim().split('\n')
  server=await createServer({root:resolve(root,'packages/app'),server:{host:'127.0.0.1',port:0,fs:{allow:[await realpath(root)]}},clearScreen:false,logLevel:'silent'})
  await server.listen()
  const address=server.httpServer.address()
  if(!address||typeof address==='string')throw Error('Vite did not bind a TCP port')
  const origin='http://127.0.0.1:'+address.port
  await (await fetch(origin+'/src/main.js')).text()
  const resolved=await server.pluginContainer.resolveId('@graph/shared',resolve(root,'packages/app/src/main.js'))
  const transformed=resolved&&await server.transformRequest(resolved.id)
  const result={first,edited,lifecycle,binTarget,resolvedId:resolved?.id,binLinked:binTarget.endsWith('/@graph/shared/cli.cjs'),viteResolvedWorkspace:resolved?.id.endsWith('/packages/shared/index.js')&&/value\s*=\s*50/.test(transformed?.code??'')}
  if(first!=='42'||edited!=='52'||[...lifecycle].sort().join(',')!=='app,shared'||!result.binLinked||!result.viteResolvedWorkspace)throw Error('Native monorepo control failed: '+JSON.stringify(result))
  console.log(JSON.stringify(result,null,2))
}finally{
  await server?.close()
  await rm(root,{recursive:true,force:true})
}
