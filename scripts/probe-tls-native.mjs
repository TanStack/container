import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const build=JSON.parse(readFileSync('public/tls-probe/build.json'))
const results=[]
const cases=[]
for(const version of [12,13]){
  for(const fragment of [1,13,16384])for(let mode=0;mode<6;mode++)cases.push({kind:'protocol',args:[mode,fragment,version,2097152,0]})
  for(const budget of [0,131072,163840,196608,229376,262144,524288])cases.push({kind:'allocation',args:[0,13,version,budget,0]})
  for(const site of [1,2,3,4,8,16,32,64,128,256,512,1024,2048,4096,8192,12000])cases.push({kind:'allocation',args:[0,13,version,2097152,site]})
}
for(const {kind,args} of cases){
  const child=spawnSync(build.directory+'/probe',args.map(String),{encoding:'utf8',timeout:15000,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}})
  let result;try{result=JSON.parse(child.stdout)}catch{}
  const passed=child.status===0&&!child.stderr&&result?.liveBytes===0&&result.peakBytes<=args[3]&&(kind==='allocation'||result.expected===1)
  results.push({kind,args,passed,status:child.status,signal:child.signal,error:String(child.error??''),stderr:child.stderr,result})
}
const passed=results.filter(item=>item.passed).length
const allocationFailures=results.filter(item=>item.kind==='allocation'&&item.result?.accepted===0).length
const allocationSuccesses=results.filter(item=>item.kind==='allocation'&&item.result?.accepted===1).length
const report={build,scriptSHA256:createHash('sha256').update(readFileSync('scripts/probe-tls-native.mjs')).digest('hex'),passed,total:results.length,allocationFailures,allocationSuccesses,results}
writeFileSync('reports/tls-probe-native.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({passed,total:results.length,allocationFailures,allocationSuccesses,failures:results.filter(item=>!item.passed)},null,2))
if(passed!==results.length)process.exitCode=1
if(!allocationFailures||!allocationSuccesses)process.exitCode=1
