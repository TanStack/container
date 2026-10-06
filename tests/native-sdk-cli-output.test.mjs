import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {readFileSync} from 'node:fs'

const moduleURL=pathToFileURL(resolve('scripts/check-native-sdk.mjs')).href
test('native SDK entrypoint and regular release checks use graceful failure output',()=>{
  const source=readFileSync('scripts/check-native-sdk.mjs','utf8')
  const entry=source.slice(source.lastIndexOf('if(process.argv[1]'))
  assert.match(entry,/runNativeSDKCheckCLI\(\)/)
  const pkg=JSON.parse(readFileSync('package.json','utf8'))
  assert.ok(pkg.scripts['test:release'].split(' ').includes('tests/native-sdk-cli-output.test.mjs'))
})
function run(source){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']})
    const stdout=[],stderr=[]
    child.stdout.on('data',bytes=>stdout.push(bytes));child.stderr.on('data',bytes=>stderr.push(bytes))
    child.once('error',reject)
    child.once('close',(status,signal)=>resolve({status,signal,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)}))
  })
}

test('native SDK CLI preserves large failed-command output through real pipes',{timeout:10000},async()=>{
  const unit='owned output é\n',count=150000,payload=unit.repeat(count),diagnostic='owned child diagnostic\n'
  const inner=`process.stdout.write(${JSON.stringify(unit)}.repeat(${count}));process.stderr.write(${JSON.stringify(diagnostic)});process.exitCode=7`
  const result=await run(`
    import {execFileSync} from 'node:child_process'
    import {runNativeSDKCheckCLI,runNativeSDKCheckCommand} from ${JSON.stringify(moduleURL)}
    runNativeSDKCheckCLI(()=>runNativeSDKCheckCommand(execFileSync, ['-e',${JSON.stringify(inner)}],
      {stdio:'pipe',encoding:'utf8',maxBuffer:64*1024*1024}))
  `)
  assert.equal(result.status,1);assert.equal(result.signal,null)
  assert.deepEqual(result.stdout,Buffer.from(payload))
  const stderr=result.stderr.toString()
  assert.ok(stderr.startsWith(diagnostic));assert.match(stderr,/Error: Command failed/)
  assert.equal(stderr.includes('stdout:'),false,'Do not duplicate the captured stream inside an inspected error object')
})

test('native SDK CLI success returns its original result without setting a failed status',{timeout:10000},async()=>{
  const result=await run(`
    import {runNativeSDKCheckCLI} from ${JSON.stringify(moduleURL)}
    const value={passed:true}
    if(runNativeSDKCheckCLI(()=>value)!==value)throw Error('Changed result')
    console.log('passed')
  `)
  assert.equal(result.status,0);assert.equal(result.signal,null)
  assert.equal(result.stdout.toString(),'passed\n');assert.equal(result.stderr.length,0)
})

test('native SDK CLI handles non-Error failures without losing its exit status',{timeout:10000},async()=>{
  const result=await run(`
    import {runNativeSDKCheckCLI} from ${JSON.stringify(moduleURL)}
    runNativeSDKCheckCLI(()=>{throw 'owned failure'})
  `)
  assert.equal(result.status,1);assert.equal(result.signal,null)
  assert.equal(result.stdout.length,0);assert.equal(result.stderr.toString(),'owned failure\n')
})
