import {test,expect} from '@playwright/test'
import {transformSync} from 'esbuild'
import {spawnSync} from 'node:child_process'
import {nodeCompatibilityVersion,sandboxVersion} from '../../src/sandbox/runtime-profile'

// Start's minimum supported Node 22 release, a candidate compilation target.
// This is a bounded language probe, not a claim of Node API compatibility.
const target='node'+nodeCompatibilityVersion
const cases:Record<string,string>={
  'disposal symbol properties':`return ['dispose','asyncDispose'].map(name=>{const value=Symbol[name],d=Object.getOwnPropertyDescriptor(Symbol,name);return [typeof value,value.description,Symbol.keyFor(value),d.writable,d.enumerable,d.configurable,Symbol.for(value.description)===value]})`,
  'class fields and private brands':`class Base{x=2}class Child extends Base{#x=3;static value=4;static{this.value++}read(){return [this.x,this.#x,Child.value,#x in this]}}return new Child().read()`,
  'optional chains and assignments':`let value;value??={nested:{count:2}};value.nested.count&&=3;value.nested.other||=4;return [value?.nested?.count,value.nested.other,value.missing?.call()]`,
  'async generators':`async function* values(){yield await Promise.resolve(2);yield 3}const result=[];for await(const value of values())result.push(value);return result`,
  'object rest and spread':`const {a,...rest}={a:1,b:2};return {...rest,c:a}`,
  'regexp indices and lookbehind':`return /(?<=a)(?<b>b)/d.exec('ab').indices.groups.b`,
  'unicode sets':`return /[\\p{ASCII}&&\\p{Letter}]/v.test('A')`,
  'bigint':`return String((2n**64n)>>32n)`,
  'resource disposal lowering':`const events=[];{using value={[Symbol.dispose](){events.push('disposed')}};events.push('body')}return events`,
  'async disposal lowering':`const events=[];{await using value={[Symbol.asyncDispose]:async()=>{await Promise.resolve();events.push('disposed')}};events.push('body')}return events`,
}
const source=Object.entries(cases).map(([name,body])=>`try{console.log(JSON.stringify([${JSON.stringify(name)},await(async()=>{${body}})()]))}catch(error){console.log(JSON.stringify([${JSON.stringify(name)},'ERROR',error.name,error.message]))}`).join('\n')
const compiled=transformSync(source,{loader:'js',format:'esm',target}).code

for(const guestWasm of [false,true])test(`Node 22 compilation target language probe (${guestWasm?'WASM bridge':'default'})`,async({page},info)=>{
  const node=spawnSync(process.execPath,['--input-type=module','-e',compiled],{encoding:'utf8',timeout:10000})
  expect(node.status,node.stderr).toBe(0)
  await page.goto('/sandbox.html')
  const guestSource=`if(process.version!==${JSON.stringify('v'+nodeCompatibilityVersion)}||process.versions.node!==${JSON.stringify(nodeCompatibilityVersion)}||process.versions.tanstackSandbox!==${JSON.stringify(sandboxVersion)}||process.platform!=='browser'||process.arch!=='wasm32'||process.release.name!=='browser-node')throw Error('Runtime identity differs from its compatibility profile');const os=await import('node:os');const cpus=os.cpus();if(cpus.length!==os.availableParallelism()||cpus.length!==1||cpus[0].model!=='Virtual CPU')throw Error('Virtual CPU policy differs');\n`+compiled
  const result=await page.evaluate(async({compiled,guestWasm})=>{
    const kernel=new window.sandboxLab.WorkerKernel({'/probe.mjs':compiled})
    try{return await kernel.runModule('/probe.mjs',{guestWasm})}finally{kernel.close()}
  },{compiled:guestSource,guestWasm})
  await info.attach('language-profile.json',{body:JSON.stringify({target,nodeVersion:process.version,node:node.stdout,result}),contentType:'application/json'})
  expect(result.exitCode,result.stderr).toBe(0)
  expect(result.stdout).toBe(node.stdout)
})
