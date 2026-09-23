import {test,expect,chromium,firefox,webkit} from '@playwright/test'
import {readFileSync} from 'node:fs'
import {npmProject} from '../fixtures/npm-project'

test('directory creation modes survive browser checkpoint reload',async({page},info)=>{
  await page.goto('/sandbox.html')
  const created=await page.evaluate(async()=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const kernel=new WorkerKernel({})
    try{
      await kernel.writeText('/create.cjs',`const fs=require('node:fs');fs.mkdirSync('/private/deep',{recursive:true,mode:0o700});fs.mkdirSync('/public',0o777);console.log('created')`)
      const result=await kernel.runModule('/create.cjs')
      if(result.exitCode===0)await checkpoint('save','directory-modes',await kernel.snapshot())
      return result
    }finally{kernel.close()}
  })
  expect(created.exitCode,created.stderr).toBe(0)
  await page.reload()
  const result=await page.evaluate(async()=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab,kernel=new WorkerKernel({})
    try{
      const saved=await checkpoint('load','directory-modes')
      if(!saved)throw Error('Missing mode checkpoint')
      await kernel.restore(saved)
      await kernel.writeText('/check.cjs',`const fs=require('node:fs');console.log(JSON.stringify(['/private','/private/deep','/public'].map(path=>fs.statSync(path).mode)))`)
      return await kernel.runModule('/check.cjs')
    }finally{kernel.close();await checkpoint('delete','directory-modes')}
  })
  await info.attach('directory-mode-reload.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([0o40700,0o40700,0o40755])
})

test('linked versionless workspace survives reload and remains editable after restore',async({page,context})=>{
  const paths=['package.json','package-lock.json','packages/app/package.json','packages/shared/package.json']
  const files={...Object.fromEntries(paths.map(path=>['/project/'+path,readFileSync('fixtures/workspace-versionless/'+path,'utf8')])),
    '/project/packages/app/index.js':'module.exports=require("@probe/shared")+2',
    '/project/packages/shared/index.js':'module.exports=40',
    '/project/entry.cjs':'console.log(require("@probe/app"))'}
  let registryRequests=0
  await context.route('https://registry.npmjs.org/**',route=>{registryRequests++;return route.abort()})
  await page.goto('/sandbox.html')
  const first=await page.evaluate(async files=>{
    const kernel=new window.sandboxLab.WorkerKernel(files)
    try{
      await kernel.install({cwd:'/project'})
      await kernel.writeText('/project/packages/shared/index.js','module.exports=50')
      await window.sandboxLab.checkpoint('save','linked-workspace',await kernel.snapshot())
      return await kernel.runModule('/project/entry.cjs',{guestWasm:true})
    }finally{kernel.close()}
  },files)
  expect(first.exitCode,first.stderr).toBe(0);expect(first.stdout).toBe('52\n')
  await page.reload()
  const result=await page.evaluate(async()=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab,kernel=new WorkerKernel({})
    try{
      const stored=await checkpoint('load','linked-workspace')
      if(!stored)throw Error('Missing workspace checkpoint')
      await kernel.restore(stored)
      const restored=await kernel.runModule('/project/entry.cjs',{guestWasm:true})
      await kernel.writeText('/project/node_modules/@probe/shared/index.js','module.exports=60')
      const source=await kernel.readText('/project/packages/shared/index.js')
      const edited=await kernel.runModule('/project/entry.cjs',{guestWasm:true})
      await kernel.install({cwd:'/project'})
      const reinstalled=await kernel.runModule('/project/entry.cjs',{guestWasm:true})
      return {restored,edited,reinstalled,source,snapshot:await kernel.snapshot()}
    }finally{kernel.close();await checkpoint('delete','linked-workspace')}
  })
  for(const execution of [result.restored,result.edited,result.reinstalled])expect(execution.exitCode,execution.stderr).toBe(0)
  expect(result.restored.stdout).toBe('52\n')
  expect(result.edited.stdout).toBe('62\n')
  expect(result.reinstalled.stdout).toBe('62\n')
  expect(result.source).toBe('module.exports=60')
  expect(result.snapshot.version).toBe(5)
  if(result.snapshot.version===5)expect(result.snapshot.symlinks['/project/node_modules/@probe/shared']).toBe('/project/packages/shared')
  expect(registryRequests).toBe(0)
})

test('installed project survives a browser process restart in an isolated profile',async({browserName,baseURL},info)=>{
  const browserType={chromium,firefox,webkit}[browserName]
  const profile=info.outputPath('checkpoint-profile')
  const fixture=npmProject()
  const first=await browserType.launchPersistentContext(profile,{headless:true,baseURL})
  try{
    await first.route('https://registry.npmjs.org/**',route=>route.fulfill({body:fixture.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}}))
    const page=await first.newPage()
    await page.goto('/sandbox.html')
    const execution=await page.evaluate(async files=>{
      const {WorkerKernel,checkpoint}=window.sandboxLab
      const kernel=new WorkerKernel(files)
      try{
        await kernel.install()
        await kernel.writeText('/node_modules/parent/node_modules/child/index.js','module.exports=4')
        await checkpoint('save','restart-project',await kernel.snapshot())
        return await kernel.runModule('/entry.cjs',{guestWasm:true})
      }finally{kernel.close()}
    },fixture.files)
    expect(execution.exitCode,execution.stderr).toBe(0)
    expect(execution.stdout).toBe('44 1\n')
  }finally{await first.close()}
  // Closing a persistent context closes its browser before the new launch.
  const second=await browserType.launchPersistentContext(profile,{headless:true,baseURL})
  let requests=0
  try{
    await second.route('https://registry.npmjs.org/**',route=>{requests++;return route.abort()})
    const page=await second.newPage()
    await page.goto('/sandbox.html')
    const execution=await page.evaluate(async()=>{
      const {WorkerKernel,checkpoint}=window.sandboxLab
      const snapshot=await checkpoint('load','restart-project')
      if(!snapshot)throw Error('Checkpoint did not survive browser restart')
      const kernel=new WorkerKernel({})
      try{
        await kernel.restore(snapshot)
        return await kernel.runModule('/entry.cjs',{guestWasm:true})
      }finally{kernel.close();await checkpoint('delete','restart-project')}
    })
    expect(execution.exitCode,execution.stderr).toBe(0)
    expect(execution.stdout).toBe('44 1\n')
    expect(requests).toBe(0)
    await info.attach('browser-restart.json',{body:JSON.stringify({browserName,execution,registryRequests:requests}),contentType:'application/json'})
  }finally{await second.close()}
})

test('persisted legacy snapshots migrate to the current format after reload',async({page})=>{
  await page.goto('/sandbox.html')
  await page.evaluate(async()=>{
    for(const version of [1,2,3,4] as const){
      const snapshot={version,files:{'/entry.cjs':new TextEncoder().encode('console.log(42)')},
        ...(version>=2?{directories:['/empty']}:{}),
        ...(version>=3?{symlinks:{'/entry-link.cjs':'/entry.cjs'}}:{}),
        ...(version===4?{fileModes:{'/entry.cjs':0o700}}:{})}
      await window.sandboxLab.checkpoint('save','legacy-'+version,snapshot as Parameters<typeof window.sandboxLab.checkpoint>[2])
    }
  })
  await page.reload()
  const results=await page.evaluate(async()=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const results=[]
    for(const version of [1,2,3,4]){
      const kernel=new WorkerKernel({})
      try{
        const stored=await checkpoint('load','legacy-'+version)
        if(!stored)throw Error('Missing legacy checkpoint')
        await kernel.restore(stored)
        const current=await kernel.snapshot()
        if(current.version!==5)throw Error('Snapshot was not migrated')
        results.push({version,current,execution:await kernel.runModule(version>=3?'/entry-link.cjs':'/entry.cjs',{guestWasm:true})})
      }finally{kernel.close();await checkpoint('delete','legacy-'+version)}
    }
    return results
  })
  for(const result of results){
    expect(result.execution.exitCode,result.execution.stderr).toBe(0)
    expect(result.execution.stdout).toBe('42\n')
    expect(result.current.directories).toEqual(result.version>=2?['/empty']:[])
    expect(result.current.symlinks).toEqual(result.version>=3?{'/entry-link.cjs':'/entry.cjs'}:{})
    expect(result.current.fileModes).toEqual({'/entry.cjs':result.version===4?0o700:0o644})
    expect(result.current.directoryModes).toEqual(result.version>=2?{'/':0o755,'/empty':0o755}:{'/':0o755})
  }
})

test('unsupported, corrupt and oversized persisted snapshots leave the live project intact',async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async()=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const kernel=new WorkerKernel({'/entry.cjs':'console.log(42)'},{workspace:{maxBytes:1024}})
    try{
      const before=await kernel.snapshot(),errors=[]
      const invalid=[{version:99,files:{}},{version:1,files:{'/bad':'not bytes'}},
        {version:4,files:{'/bad':new Uint8Array([1])},directories:[],symlinks:{},fileModes:{}},
        {version:1,files:{'/large':new Uint8Array(2048)}}]
      for(const snapshot of invalid){
        await checkpoint('save','invalid-project',snapshot as Parameters<typeof checkpoint>[2])
        const stored=await checkpoint('load','invalid-project')
        let error=''
        try{await kernel.restore(stored!)}catch(failure){error=String(failure)}
        const after=await kernel.snapshot()
        errors.push({error,unchanged:JSON.stringify(before)===JSON.stringify(after)})
      }
      return {errors,execution:await kernel.runModule('/entry.cjs',{guestWasm:true})}
    }finally{kernel.close();await checkpoint('delete','invalid-project')}
  })
  expect(result.errors.map(row=>row.unchanged)).toEqual([true,true,true,true])
  expect(result.errors.map(row=>row.error)).toEqual([
    expect.stringContaining('Invalid snapshot'),expect.stringContaining('Invalid snapshot file'),
    expect.stringContaining('Incomplete snapshot file modes'),expect.stringContaining('ENOSPC')])
  expect(result.execution.exitCode,result.execution.stderr).toBe(0)
  expect(result.execution.stdout).toBe('42\n')
})

for(const mode of ['abort','quota','clone'] as const)test(`failed checkpoint save preserves the previous project: ${mode}`,async({page})=>{
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async mode=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const kernel=new WorkerKernel({'/entry.cjs':'console.log(42)'})
    const originalPut=IDBObjectStore.prototype.put
    try{
      await checkpoint('save','durable-project',await kernel.snapshot())
      await kernel.writeText('/entry.cjs','console.log(99)')
      const replacement=await kernel.snapshot()
      // Fault injection at the storage boundary, not a real disk quota test.
      IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore['put']>){
        if(mode==='quota')throw new DOMException('Injected storage quota failure','QuotaExceededError')
        if(mode==='clone')return originalPut.call(this,()=>{},args[1])
        const request=originalPut.apply(this,args)
        this.transaction.abort()
        return request
      }
      let error=''
      try{await checkpoint('save','durable-project',replacement)}catch(failure){error=String(failure)}
      finally{IDBObjectStore.prototype.put=originalPut}
      const saved=await checkpoint('load','durable-project')
      if(!saved)throw Error('Failed save removed the previous checkpoint')
      await kernel.restore(saved)
      const previous=await kernel.runModule('/entry.cjs',{guestWasm:true})
      await checkpoint('save','durable-project',replacement)
      const recovered=await checkpoint('load','durable-project')
      if(!recovered)throw Error('Recovery save missing')
      await kernel.restore(recovered)
      return {error,previous,recovered:await kernel.runModule('/entry.cjs',{guestWasm:true})}
    }finally{
      IDBObjectStore.prototype.put=originalPut
      kernel.close()
      await checkpoint('delete','durable-project')
    }
  },mode)
  expect(result.error).toMatch(mode==='quota'?/QuotaExceededError/:mode==='clone'?/DataCloneError/:/abort/i)
  expect(result.previous.exitCode,result.previous.stderr).toBe(0)
  expect(result.previous.stdout).toBe('42\n')
  expect(result.recovered.exitCode,result.recovered.stderr).toBe(0)
  expect(result.recovered.stdout).toBe('99\n')
})

test('installed project survives page reload with edited dependencies, binary files and executable links',async({page,context},info)=>{
  const fixture=npmProject()
  let downloads=0,offline=false
  await context.route('https://registry.npmjs.org/**',route=>{
    downloads++
    return offline?route.abort():route.fulfill({body:fixture.archives[route.request().url()],headers:{'access-control-allow-origin':'*'}})
  })
  await page.goto('/sandbox.html')
  const before=await page.evaluate(async files=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const kernel=new WorkerKernel(files)
    try{
      await kernel.install()
      await kernel.writeText('/node_modules/parent/node_modules/child/index.js','module.exports=3')
      await kernel.writeFile('/state.bin',new Uint8Array([0,255,128,1]))
      await kernel.writeText('/inspect.cjs',`const fs=require('node:fs');console.log(fs.realpathSync('/node_modules/.bin/parent'));`)
      const execution=await kernel.runModule('/entry.cjs',{guestWasm:true})
      await checkpoint('save','installed-project',await kernel.snapshot())
      return execution
    }finally{kernel.close()}
  },fixture.files)
  expect(before.exitCode,before.stderr).toBe(0)
  expect(before.stdout).toBe('43 1\n')
  expect(downloads).toBe(3)
  offline=true
  await page.reload()
  const after=await page.evaluate(async()=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const saved=await checkpoint('load','installed-project')
    if(!saved)throw Error('Missing persisted project')
    const kernel=new WorkerKernel({})
    try{
      await kernel.restore(saved)
      return {execution:await kernel.runModule('/entry.cjs',{guestWasm:true}),
        link:await kernel.runModule('/inspect.cjs',{guestWasm:true}),
        binary:Array.from(await kernel.readFile('/state.bin'))}
    }finally{kernel.close();await checkpoint('delete','installed-project')}
  })
  await info.attach('reload-project.json',{body:JSON.stringify({before,after,downloads}),contentType:'application/json'})
  expect(after.execution.exitCode,after.execution.stderr).toBe(0)
  expect(after.execution.stdout).toBe(before.stdout)
  expect(after.link.exitCode,after.link.stderr).toBe(0)
  expect(after.link.stdout).toBe('/node_modules/parent/index.js\n')
  expect(after.binary).toEqual([0,255,128,1])
  expect(downloads).toBe(3)
})

test('published React project resumes SSR after reload without registry access',async({page,context},info)=>{
  const files=Object.fromEntries(['package.json','package-lock.json','entry.mjs'].map(name=>['/'+name,readFileSync('fixtures/install-react/'+name,'utf8')]))
  await page.goto('/sandbox.html')
  const before=await page.evaluate(async files=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const kernel=new WorkerKernel(files)
    try{
      const installation=await kernel.install()
      await kernel.writeText('/entry.mjs',files['/entry.mjs'].replace('Installed in the worker','Restored after reload'))
      const execution=await kernel.runModule('/entry.mjs',{guestWasm:true,webAPIs:true,maxBytes:32*1024*1024,timeoutMs:10000})
      await checkpoint('save','react-project',await kernel.snapshot())
      return {installation,execution}
    }finally{kernel.close()}
  },files)
  expect(before.installation.installed).toBe(3)
  expect(before.execution.exitCode,before.execution.stderr).toBe(0)
  expect(before.execution.stdout).toBe('<h1>Restored after reload</h1>\n')
  let registryRequests=0
  await context.route('https://registry.npmjs.org/**',route=>{registryRequests++;return route.abort()})
  await page.reload()
  const after=await page.evaluate(async()=>{
    const {WorkerKernel,checkpoint}=window.sandboxLab
    const snapshot=await checkpoint('load','react-project')
    if(!snapshot)throw Error('Missing persisted React project')
    const kernel=new WorkerKernel({})
    try{
      await kernel.restore(snapshot)
      return await kernel.runModule('/entry.mjs',{guestWasm:true,webAPIs:true,maxBytes:32*1024*1024,timeoutMs:10000})
    }finally{kernel.close();await checkpoint('delete','react-project')}
  })
  await info.attach('reload-react.json',{body:JSON.stringify({before,after,registryRequests}),contentType:'application/json'})
  expect(after.exitCode,after.stderr).toBe(0)
  expect(after.stdout).toBe(before.execution.stdout)
  expect(registryRequests).toBe(0)
})
