import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runInstalledNativeProbe} from './fixtures/native-installed-probe-host.mjs'
import {nativeVitePrivateFiles,probeVitePrivateImports} from './fixtures/native-vite-private-imports.mjs'

test('real Vite private imports and virtual hooks complete through the installed workspace pipeline',{
  skip:process.env.NATIVE_VITE_PRIVATE_CONTROL!=='1'?'Opt-in installed Vite private-import control':false,timeout:180000,
},async()=>{
  const sdk=process.env.NATIVE_SDK_BUNDLE_DIR,deployment=process.env.NATIVE_DEPLOYMENT_DIR
  assert.ok(sdk&&deployment,'Pass the installed SDK and deployment')
  const root=resolve(process.env.NATIVE_SOURCE_ROOT??process.cwd())
  const {nativeReleaseAcceptanceIdentity}=await import(pathToFileURL(join(root,'scripts/native-release-acceptance.mjs')).href)
  const before=nativeReleaseAcceptanceIdentity(root,sdk,deployment)
  const require=createRequire(import.meta.url)
  const viteManifest=await readFile(require.resolve('vite/package.json'),'utf8')
  assert.equal(JSON.parse(viteManifest).version,'8.3.1')
  const viteEntry=await readFile(require.resolve('vite'),'utf8')
  const rolldownManifest=await readFile(require.resolve('rolldown/package.json'),'utf8')
  assert.equal(JSON.parse(rolldownManifest).version,'1.2.11')
  const rolldownEntry=await readFile(require.resolve('rolldown'),'utf8')
  const files={...Object.fromEntries(Object.entries(nativeVitePrivateFiles).map(([path,value])=>['/app/'+path,value])),
    '/app/node_modules/vite/package.json':viteManifest,'/app/node_modules/vite/dist/node/index.js':viteEntry,
    '/app/node_modules/rolldown/package.json':rolldownManifest,'/app/node_modules/rolldown/dist/index.mjs':rolldownEntry}
  const source=`import {createServer as createHTTPServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    import {createServer} from 'vite';
    import {rolldown} from 'rolldown';
    const probe=(${probeVitePrivateImports.toString()});
    createHTTPServer(async(req,res)=>{
      res.setHeader('Connection','close');
      if(req.url!=='/run'){res.end('ok');return}
      try{const result=await probe(createServer,{root:'/app',rolldown,cold:${process.env.NATIVE_VITE_PRIVATE_COLD==='1'},
        report:state=>writeFileSync('/app/private-state.json',JSON.stringify(state))});
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({passed:result.passed,result}));}
      catch(error){res.statusCode=500;res.end(JSON.stringify({passed:false,error:String(error)}));}
    }).listen(3000,'127.0.0.1');`
  const rows=await runInstalledNativeProbe({sdk,deployment,files,source,statePath:'/app/private-state.json'})
  const failures=[]
  for(const row of rows){
    let passed=false
    try{
      assert.equal(row.error,undefined)
      assert.equal(row.result.status,200);assert.equal(row.result.body.passed,true)
      assert.equal(row.result.body.result.resolved.length,21)
      assert.equal(row.result.body.result.transformed,1);assert.equal(row.result.body.result.evaluated,2)
      assert.equal(row.result.body.result.virtualClaims,10)
      assert.equal(row.result.body.result.nestedClaims,2);assert.equal(row.result.body.result.bundleEvaluated,1)
      assert.deepEqual(row.result.body.result.failures,[])
      assert.equal(row.result.stateError,undefined);assert.equal(row.result.disposeError,undefined)
      assert.deepEqual(row.result.diagnostics,[])
      assert.equal(row.result.resources.sockets,0);assert.equal(row.result.resources.responseStreams,0)
      passed=true
    }catch(error){failures.push({browser:row.browser,error:String(error)})}
    console.log(JSON.stringify({...row,passed}))
  }
  assert.deepEqual(nativeReleaseAcceptanceIdentity(root,sdk,deployment),before,'Installed inputs changed')
  assert.deepEqual(failures,[],'Vite private-import pipeline failed')
})
