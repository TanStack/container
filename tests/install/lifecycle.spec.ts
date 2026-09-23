import {expect,test} from '@playwright/test'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {npmProject,tarArchive} from '../fixtures/npm-project'

function lifecycleProject(fail=false){
  const fixture=npmProject(),parent=fixture.lock.packages['node_modules/parent']
  const helper=`const fs=require('node:fs'),path='/lifecycle.json';const rows=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):[];rows.push([process.argv.at(-1),process.cwd(),process.env.INIT_CWD,process.env.npm_lifecycle_event,process.env.npm_lifecycle_script,process.env.npm_package_name]);fs.writeFileSync(path,JSON.stringify(rows))`
  const scripts={preinstall:'lifecycle-helper preinstall',install:fail?'node -e "process.exit(7)"':'lifecycle-helper install',postinstall:'lifecycle-helper postinstall',prepublish:'lifecycle-helper prepublish',preprepare:'lifecycle-helper preprepare',prepare:'lifecycle-helper prepare',postprepare:'lifecycle-helper postprepare'}
  Object.assign(fixture.manifest,{scripts});Object.assign(fixture.lock.packages[''],{scripts});fixture.files['/package.json']=JSON.stringify(fixture.manifest)
  const manifest={name:'parent',version:'1.0.0',dependencies:{child:'2.0.0'},bin:{parent:'index.js','lifecycle-helper':'lifecycle.js'},scripts}
  const archive=gzipSync(tarArchive({'package/package.json':JSON.stringify(manifest),'package/index.js':'module.exports=require("child")','package/lifecycle.js':helper})),oldURL=parent.resolved
  if(fail){parent.resolved='https://registry.npmjs.org/parent/-/parent-1.0.0-failing.tgz';delete fixture.archives[oldURL]}
  Object.assign(parent,{bin:manifest.bin,scripts,hasInstallScript:true,integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')})
  fixture.archives[parent.resolved]=archive;fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  return fixture
}

test('npm-style install hooks use package cwd env PATH and roll back failures',async({page,context},info)=>{
  const successful=lifecycleProject(),failing=lifecycleProject(true),archives={...successful.archives,...failing.archives}
  await context.route('https://registry.npmjs.org/**',route=>route.fulfill({body:archives[route.request().url()],headers:{'access-control-allow-origin':'*'}}))
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async({successful,failing})=>{
    const run=async(files:Record<string,string>,repair:boolean)=>{
      const kernel=new window.sandboxLab.WorkerKernel(files)
      try{
        let error='';try{await kernel.install()}catch(reason){error=String(reason)}
        const rolledBack=error?!(await kernel.snapshot()).files['/node_modules/parent/package.json']:false
        if(repair){await kernel.writeText('/package.json',successful.files['/package.json']);await kernel.writeText('/package-lock.json',successful.files['/package-lock.json']);await kernel.install()}
        const snapshot=await kernel.snapshot()
        return {error,rolledBack,rows:JSON.parse(await kernel.readText('/lifecycle.json')) as string[][],bin:'symlinks' in snapshot?snapshot.symlinks['/node_modules/.bin/lifecycle-helper']:undefined}
      }finally{kernel.close()}
    }
    return {success:await run(successful.files,false),failure:await run(failing.files,true)}
  },{successful:{files:successful.files},failing:{files:failing.files}})
  await info.attach('lifecycle.json',{body:JSON.stringify(result),contentType:'application/json'})
  for(const value of [result.success,result.failure]){
    expect(value.rows.map((row:string[])=>row[3])).toEqual(['preinstall','install','postinstall','preinstall','install','postinstall','prepublish','preprepare','prepare','postprepare'])
    expect(value.rows.every((row:string[])=>row[2]==='/'&&row[3]===row[0])).toBe(true)
    expect(value.bin).toBe('/node_modules/parent/lifecycle.js')
  }
  expect(result.success.error).toBe('');expect(result.failure.error).toContain('Package install script failed');expect(result.failure.rolledBack).toBe(true)
})
