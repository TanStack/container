import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {nativeCommandBootstrapRequirements,readNativeCommandBootstrapResults} from '../scripts/native-command-bootstrap-results.mjs'

const toolchains=[{vite:'8.3.1',rolldown:'1.2.11'},{vite:'8.3.2',rolldown:'1.2.12'}]
function fixture(){
  const inputs={kind:'command-bootstrap-inputs',testSHA256:'a'.repeat(64),runnerLockSHA256:'b'.repeat(64),selected:['chromium','firefox','webkit']}
  const rows=inputs.selected.flatMap(browser=>toolchains.map(toolchain=>({kind:'command-bootstrap-result',browser,toolchain:{...toolchain},passed:true,errors:[],
    commands:nativeCommandBootstrapRequirements.map(entry=>({name:entry.name,status:entry.status??0,commands:0,truncated:false,cwd:'/app',elapsedMs:5,
      stdout:entry.json?JSON.stringify(entry.json):entry.stdout??'',stderr:entry.error?'Error: '+entry.error:''})),
  })))
  return {inputs,rows}
}
const serialize=({inputs,rows})=>[inputs,...rows].map(row=>JSON.stringify(row)).join('\n')

test('bootstrap acceptance requires all 102 command cases and both runtimes in every engine',()=>{
  const parsed=readNativeCommandBootstrapResults(serialize(fixture()),toolchains)
  assert.equal(parsed.rows.length,6);assert.equal(parsed.rows.flatMap(row=>row.commands).length,102)
})
test('bootstrap acceptance rejects incomplete, duplicate or failed browser pairs',()=>{
  for(const mutate of [data=>data.rows.pop(),data=>data.rows[1]=data.rows[0],data=>data.rows[0].passed=false,
    data=>data.rows[0].errors.push('page error'),data=>data.inputs.selected.pop(),data=>delete data.inputs.testSHA256,
    data=>data.inputs.runnerLockSHA256='not-a-hash',data=>data.rows[0].toolchain.rolldown='1.0.0']){
    const data=fixture();mutate(data);assert.throws(()=>readNativeCommandBootstrapResults(serialize(data),toolchains))
  }
  assert.throws(()=>readNativeCommandBootstrapResults(serialize(fixture()),toolchains.slice(0,1)))
  assert.throws(()=>readNativeCommandBootstrapResults(fixture().rows.map(JSON.stringify).join('\n'),toolchains))
})
test('bootstrap acceptance rejects skipped cases, leaks, truncation, output errors and invalid timing',()=>{
  for(const mutate of [row=>row.commands.pop(),row=>row.commands.reverse(),row=>row.commands[0].commands=1,
    row=>row.commands[0].status=1,row=>row.commands[0].truncated=true,row=>row.commands[0].stderr='error',
    row=>row.commands[0].cwd='/tmp',row=>row.commands[0].elapsedMs=-1,row=>delete row.commands[0].stdout,
    row=>delete row.commands[0].stderr,row=>row.commands[0].elapsedMs=0.5]){
    const data=fixture();mutate(data.rows[0]);assert.throws(()=>readNativeCommandBootstrapResults(serialize(data),toolchains))
  }
})
test('bootstrap acceptance independently checks every successful command result',()=>{
  for(const requirement of nativeCommandBootstrapRequirements.filter(entry=>!entry.error)){
    const data=fixture(),command=data.rows[0].commands.find(command=>command.name===requirement.name)
    command.stdout=requirement.json?'{}':'wrong output'
    assert.throws(()=>readNativeCommandBootstrapResults(serialize(data),toolchains),requirement.name)
  }
})
test('bootstrap acceptance distinguishes the intended guest exception from infrastructure failure',()=>{
  for(const failure of [{status:0,stderr:''},{status:1,stderr:'worker startup failed'},{status:2,stderr:'bootstrap guest failure'}]){
    const data=fixture(),command=data.rows[0].commands.find(command=>command.name==='failure')
    Object.assign(command,failure)
    assert.throws(()=>readNativeCommandBootstrapResults(serialize(data),toolchains))
  }
})
test('installed bootstrap tests bound each browser separately and retain the full matrix',()=>{
  const source=readFileSync(new URL('./native-command-bootstrap-sdk.test.mjs',import.meta.url),'utf8')
  assert.match(source,/for\(const targetBrowser of \['chromium','firefox','webkit'\]\)test\(/)
  assert.match(source,/timeout:180000/)
  assert.match(source,/for\(const name of \[targetBrowser\]\)/)
  assert.match(source,/selected:selectedBootstrapBrowsers/)
  assert.match(source,/assert\.deepEqual\(inputs,bootstrapInputs,'Bootstrap inputs changed between browser tests'\)/)
  assert.match(source,/for\(const \[index,candidate\] of candidates\.entries\(\)\)/)
  assert.match(source,/for\(const entry of cases\)/)
  assert.match(source,/assert\.equal\(result\.commands\.length,cases\.length\)/)
})
