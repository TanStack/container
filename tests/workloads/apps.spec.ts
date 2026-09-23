import {test,expect} from '@playwright/test'
for(const framework of ['react','vue','svelte','solid']){
  test('interactive '+framework+' | browser Vite build, CSS, asset, click, edit, restore',async({page},info)=>{
    await page.goto('/sandbox.html')
    const errors:string[]=[]
    page.on('pageerror',error=>errors.push(String(error)))
    const iterations=[]
    for(const value of [3,7,7,3]){
      const built=await page.evaluate(async({framework,value})=>{
        const graph=await (await fetch('/workloads/apps/'+framework+'.json')).json()
        const files:Record<string,Uint8Array|string>=Object.fromEntries(Object.entries(graph.files as Record<string,{base64:string}>).map(([name,file])=>[name,Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))]))
        files['/app/src/input.json']=JSON.stringify({value})
        if(graph.component){
          files['/app/src/Component.js']=await new Promise<string>((resolve,reject)=>{
            const worker=new Worker('/workloads/apps/svelte-compiler.mjs',{type:'module'})
            const timer=setTimeout(()=>{worker.terminate();reject(Error('Svelte compiler timeout'))},30000)
            worker.onmessage=e=>{clearTimeout(timer);worker.terminate();e.data.error?reject(Error(e.data.error)):resolve(e.data.code)}
            worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(Error(e.message))}
            worker.postMessage(graph.component)
          })
        }
        const engine=await window.sandboxLab.loadBrowserViteEngine()
        const result=await engine.runBrowserViteSmokeBuild(files)
        const outputs=Object.entries(result.files).map(([name,data])=>[name,new TextDecoder().decode(data)])
        const scripts=outputs.filter(([name])=>/\.(m?js)$/.test(name))
        if(scripts.length!==1)throw Error('This fixture requires one self-contained client entry, got '+scripts.length)
        const css=outputs.filter(([name])=>name.endsWith('.css')).map(([,text])=>text).join('\n')
        if(!css)throw Error('No emitted CSS')
        const frame=document.createElement('iframe');frame.id='workload-app';frame.sandbox.add('allow-scripts')
        frame.srcdoc='<style>'+css+'</style><img id="logo" alt="Fixture logo"><div id="app"></div><script type="module">'+scripts[0][1].replaceAll('</script','<\\/script')+'</script>'
        document.querySelector('#preview')!.replaceChildren(frame)
        return {durationMs:result.duration,outputs:outputs.map(([name,text])=>({name,bytes:text.length}))}
      },{framework,value})
      const frame=page.frameLocator('#workload-app')
      await expect(frame.getByRole('button')).toHaveText('Count '+value)
      await expect(frame.getByRole('button')).toHaveCSS('color','rgb(12, 34, 56)')
      await expect(frame.getByRole('img')).toHaveJSProperty('naturalWidth',16)
      await frame.getByRole('button').click()
      await expect(frame.getByRole('button')).toHaveText('Count '+(value+1))
      iterations.push({value,...built})
    }
    const report={framework,status:'adapted-pass',placement:'trusted browser Vite toolchain and opaque DOM preview, not QuickJS',iterations}
    await info.attach('browser-app.json',{body:JSON.stringify(report),contentType:'application/json'})
    if(framework==='svelte')await page.screenshot({path:'reports/workload-app-'+info.project.name+'.png'})
    expect(errors).toEqual([])
  })
}
