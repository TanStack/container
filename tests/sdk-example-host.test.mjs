import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'

for(const [kind,ownerPort,previewPort] of [['basic',4173,4174],['frameworks',4175,4176]]){
  const {examplePorts,listen,closeServer}=await import(`../examples/sdk-${kind}/host.mjs`)
  const defaults={ownerPort,previewPort}
  test(`${kind} host accepts stable defaults, explicit ports and temporary ports`,()=>{
    assert.deepEqual(examplePorts(defaults),defaults)
    assert.deepEqual(examplePorts(defaults,{ownerPort:undefined,previewPort:undefined}),defaults)
    assert.deepEqual(examplePorts(defaults,{ownerPort:'4273',previewPort:'4274'}),{ownerPort:4273,previewPort:4274})
    assert.deepEqual(examplePorts(defaults,{ownerPort:0,previewPort:'0'}),{ownerPort:0,previewPort:0})
    assert.deepEqual(examplePorts(defaults,{ownerPort:65535}),{ownerPort:65535,previewPort})
    for(const invalid of [-1,65536,1.5,NaN,Infinity,'',' ','1e3','42x',false,{}]){
      for(const name of ['ownerPort','previewPort'])assert.throws(()=>examplePorts(defaults,{[name]:invalid}),/integer from 0 to 65535/)
    }
    assert.throws(()=>examplePorts(defaults,{ownerPort:4273,previewPort:4273}),/must be different/)
  })
  test(`${kind} host keeps separate temporary origins and restarts on the selected port`,async()=>{
    const owner=createServer(),preview=createServer()
    const ownerOrigin=await listen(owner,0)
    try{
      const previewOrigin=await listen(preview,0)
      try{assert.notEqual(ownerOrigin,previewOrigin)}finally{await closeServer(preview)}
    }finally{await closeServer(owner)}
    const restarted=createServer()
    const restartedOrigin=await listen(restarted,Number(new URL(ownerOrigin).port))
    try{assert.equal(restartedOrigin,ownerOrigin)}finally{await closeServer(restarted)}
  })
  test(`${kind} host reports port conflicts without selecting another origin`,async()=>{
    const occupied=createServer(),contender=createServer()
    const initialListeners=contender.listenerCount('listening')
    const origin=await listen(occupied,0)
    const port=Number(new URL(origin).port)
    try{
      await assert.rejects(listen(contender,port),{code:'EADDRINUSE'})
      assert.equal(contender.listening,false)
      assert.equal(contender.listenerCount('listening'),initialListeners)
    }finally{await closeServer(occupied)}
    assert.equal(await listen(contender,port),origin)
    await closeServer(contender)
  })
  test(`${kind} host wires stable defaults and explicit automation ports`,()=>{
    const source=readFileSync(`examples/sdk-${kind}/server.mjs`,'utf8')
    assert.ok(source.includes(`examplePorts({ownerPort:${ownerPort},previewPort:${previewPort}},options)`))
    assert.match(source,/ownerPort:process\.env\.OWNER_PORT,previewPort:process\.env\.PREVIEW_PORT/)
    assert.match(source,/await listen\(preview,previewPort\)/)
    assert.match(source,/await listen\(owner,ownerPort\)/)
    assert.match(source,/catch\(error\)\{await closeServer\(preview\);throw error\}/)
    const spec=kind==='basic'?'basic-example':'framework-example'
    assert.match(readFileSync(`tests/sdk/${spec}.spec.mjs`,'utf8'),/startExample\(\{ownerPort:0,previewPort:0\}\)/)
  })
}

test('both copied examples ship their standalone host helper',()=>{
  const source=readFileSync('scripts/build-sdk-packages.mjs','utf8')
  for(const kind of ['basic','frameworks'])assert.match(source,new RegExp(kind+":\\['README\\.md'[^\\n]+?'host\\.mjs'"))
  assert.match(source,/for\(const file of files\)copy\(join\(sourceRoot,'examples','sdk-'\+name,file\),join\(core,'examples',name,file\)\)/)
  assert.equal(readFileSync('examples/sdk-basic/host.mjs','utf8'),readFileSync('examples/sdk-frameworks/host.mjs','utf8'))
})
test('split examples assemble runtime assets and serve generated kernel hosts separately from core',()=>{
  for(const name of ['sdk-basic','sdk-frameworks']){
    const server=readFileSync(`examples/${name}/server.mjs`,'utf8')
    assert.match(server,/await prepareRuntimeAssets\(join\(workspace,'deployment'\)\)/)
    assert.match(server,/deployment\.previewHostDirectory/)
    assert.match(server,/sendFile\(response,deployment\.directory,path\.slice\(5\)\)/)
    assert.match(server,/preparedAssets:deployment/)
    assert.doesNotMatch(server,/copyRuntimeAssets|join\(packageRoot,'manifest.json'\)/)
  }
})
