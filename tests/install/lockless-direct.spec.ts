import {test,expect} from '@playwright/test'
import {gzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {tarArchive} from '../fixtures/npm-project'

test('lockless semver install hoists and nests transitive versions while validating peers',async({page,context})=>{
  const archives:Record<string,Buffer>={},metadata:Record<string,unknown>={}
  const add=(name:string,versions:Array<{version:string;dependencies?:Record<string,string>;peerDependencies?:Record<string,string>}>)=>{
    const entries:Record<string,unknown>={}
    for(const item of versions){
      const archive=gzipSync(tarArchive({'package/package.json':JSON.stringify({name,...item,main:'index.js'}),'package/index.js':'module.exports='+JSON.stringify(item.version)}))
      const tarball=`https://registry.npmjs.org/${name}/-/${name}-${item.version}.tgz`
      archives[tarball]=archive
      entries[item.version]={name,...item,dist:{tarball,integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}}
    }
    metadata[name]={name,versions:entries}
  }
  add('alpha',[{version:'1.0.0'},{version:'1.5.0',dependencies:{shared:'^1'}},{version:'2.0.0'}])
  add('beta',[{version:'2.0.1',dependencies:{shared:'^2'},peerDependencies:{alpha:'^1.2.0'}}])
  add('shared',[{version:'1.4.0'},{version:'2.3.0'}])
  await context.route('https://registry.npmjs.org/**',route=>{
    const url=route.request().url(),name=Object.keys(metadata).find(name=>url.endsWith('/'+name))
    return route.fulfill(name?{json:metadata[name],headers:{'access-control-allow-origin':'*'}}:{body:archives[url],headers:{'access-control-allow-origin':'*'}})
  })
  await page.goto('/sandbox.html')
  const files={'/package.json':JSON.stringify({name:'lockless-browser',version:'1.0.0',dependencies:{beta:'^2.0.0',alpha:'^1.0.0'}}),
    '/entry.cjs':'console.log(require("alpha"),require("beta"))','/keep':'keep'}
  const result=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{return {install:await kernel.install(),execution:await kernel.runModule('/entry.cjs',{guestWasm:true}),alpha:JSON.parse(await kernel.readText('/node_modules/alpha/package.json')),shared:JSON.parse(await kernel.readText('/node_modules/shared/package.json')),nested:JSON.parse(await kernel.readText('/node_modules/beta/node_modules/shared/package.json')),snapshot:await kernel.snapshot()}}
    finally{kernel.close()}
  },files)
  expect(result.install.installed).toBe(4)
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout).toBe('1.5.0 2.0.1\n')
  expect(result.alpha).toMatchObject({version:'1.5.0'})
  expect(result.shared).toMatchObject({version:'1.4.0'})
  expect(result.nested).toMatchObject({version:'2.3.0'})
  expect(result.snapshot.files['/package-lock.json']).toBeUndefined()
})
