import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {nativeBinaryShellFiles} from '../tests/fixtures/native-binary-shell.mjs'

const directory=await mkdtemp(join(tmpdir(),'container-binary-shell-control-'))
for(const [path,source] of Object.entries(nativeBinaryShellFiles)){
  assert.ok(path.startsWith('/app/')&&!path.slice(5).includes('/'))
  await writeFile(join(directory,path.slice(5)),source,{flag:'wx'})
}
const commands=[
  'node output-probe.js | cat > pipeline.bin',
  'node output-probe.js > direct.bin',
  'node error-probe.js 2> error.bin',
  'node burst-probe.js | cat > burst.bin',
  'node worker-burst.js | cat > worker.bin',
  'node fork-burst.js | cat > fork.bin',
  'node burst-probe.js | node slow-input.js > stdin.bin',
  'node burst-probe.js | node fork-input.js > fork-input.bin',
  'node delayed-input-producer.js data | node listener-input.js data > lifetime-data.bin',
  'node delayed-input-producer.js readable | node listener-input.js readable > lifetime-readable.bin',
]
for(const command of commands){
  await new Promise((resolve,reject)=>{
    const child=spawn('/bin/bash',['-o','pipefail','-c',command],{cwd:directory,
      env:{...process.env,PATH:[join(process.execPath,'..'),process.env.PATH].join(':')},stdio:'inherit'})
    child.once('error',reject)
    child.once('exit',(code,signal)=>code===0?resolve():reject(Error(`${command}: exit ${code}, signal ${signal}`)))
  })
}
for(const name of ['pipeline.bin','direct.bin','error.bin','lifetime-data.bin','lifetime-readable.bin']){
  assert.deepEqual([...await readFile(join(directory,name))],[255,0,240,159,152,128])
}
for(const mode of ['data','readable'])assert.equal(await readFile(join(directory,'input-listener-ended-'+mode),'utf8'),'6')
for(const name of ['burst.bin','worker.bin','fork.bin','stdin.bin','fork-input.bin']){
  const bytes=await readFile(join(directory,name))
  assert.equal(bytes.length,4*1024*1024)
  for(let i=0;i<bytes.length;i++)assert.equal(bytes[i],i%65536%251)
}
const stdinMetrics=JSON.parse(await readFile(join(directory,'stdin-result.json'),'utf8'))
assert.equal(stdinMetrics.received,4*1024*1024)
assert.equal(stdinMetrics.mismatches,0)
assert.ok(Number.isInteger(stdinMetrics.maxBuffered)&&stdinMetrics.maxBuffered<=131072)
console.log(JSON.stringify({directory,node:process.version,commands:commands.length,
  fixtureSHA256:createHash('sha256').update(JSON.stringify(nativeBinaryShellFiles)).digest('hex'),
  bursts:5,bytesPerBurst:4*1024*1024,mismatches:0,stdinMetrics}))
