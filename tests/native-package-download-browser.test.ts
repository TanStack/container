import {expect,test} from 'vitest'
import {build} from 'esbuild'
import {chromium,firefox,webkit} from 'playwright'
import {npmProject} from './fixtures/npm-project'

test('locked custom-origin installs keep policy and integrity behavior in every desktop engine',async()=>{
  const fixture=npmProject()
  const archives:Record<string,number[]>={}
  for(const entry of Object.values(fixture.lock.packages) as Array<{resolved?:string}>){
    if(!entry.resolved)continue
    const previous=entry.resolved
    entry.resolved=previous.replace('https://registry.npmjs.org','https://packages.example')
    archives[entry.resolved]=Array.from(fixture.archives[previous])
  }
  fixture.files['/package-lock.json']=JSON.stringify(fixture.lock)
  const bundled=await build({stdin:{contents:`export {installProject} from './src/npm/project'; export {WorkspaceFiles} from './src/sandbox/files';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})
  for(const [name,engine]of Object.entries({chromium,firefox,webkit})){
    const browser=await engine.launch()
    try{
      const page=await browser.newPage()
      const result=await page.evaluate(async({source,files,archives})=>{
        const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}))
        const originalFetch=globalThis.fetch
        let workspace
        try{
          const {installProject,WorkspaceFiles}=await new Function('url','return import(url)')(url)
          workspace=new WorkspaceFiles(files)
          let requests=0
          globalThis.fetch=async(url,options)=>{
            if(options.credentials!=='omit'||options.redirect!=='error')throw Error('Package transport options changed')
            requests++
            return new Response(new Uint8Array(archives[String(url)]))
          }
          const initial=workspace.snapshot()
          let denied
          try{await installProject(workspace)}catch(error){denied=String(error)}
          const unchanged=JSON.stringify(workspace.snapshot())===JSON.stringify(initial)
          const beforeAllowed=requests
          const installed=await installProject(workspace,{packageDownloadPolicy:{additionalOrigins:['https://packages.example']}})
          return {denied,unchanged,beforeAllowed,installed:installed.installed,requests,
            executable:workspace.realpathSync('/node_modules/.bin/parent'),
            retained:new TextDecoder().decode(workspace.readFileSync('/keep.txt'))}
        }finally{workspace?.close();globalThis.fetch=originalFetch;URL.revokeObjectURL(url)}
      },{source:bundled.outputFiles[0].text,files:fixture.files,archives})
      expect(result.denied,name).toContain('host-configured origins')
      expect(result.unchanged,name).toBe(true);expect(result.beforeAllowed,name).toBe(0)
      expect(result.installed,name).toBe(3);expect(result.requests,name).toBe(3)
      expect(result.executable,name).toBe('/node_modules/parent/index.js')
      expect(result.retained,name).toBe('keep')
    }finally{await browser.close()}
  }
},30_000)
