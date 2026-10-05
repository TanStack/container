import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {runTerminalMatrix,terminalMatrixInputs,terminalMatrixOptions,terminalMatrixPlan} from './probe-local-native-terminal-matrix.mjs'

export function terminalRepeatOptions(args){
  const matrixArgs=args.slice(0,3)
  let runs=2,seen=false
  assert.equal((args.length-3)%2,0,'Pass option/value pairs')
  for(let index=3;index<args.length;index+=2){
    if(args[index]==='--runs'){
      assert.equal(seen,false,'Repeated --runs');seen=true
      assert.match(args[index+1],/^[2-5]$/,'Terminal repeats require 2..5 complete matrices')
      runs=Number(args[index+1])
    }else matrixArgs.push(args[index],args[index+1])
  }
  return {...terminalMatrixOptions(matrixArgs),runs}
}

export function terminalRepeatOutcome(matrix){
  const plan=terminalMatrixPlan()
  return matrix.complete===true&&matrix.passed===true&&
    !matrix.runnerError&&!matrix.interrupted&&!matrix.stoppedReason&&
    Array.isArray(matrix.rows)&&matrix.rows.length===plan.length&&
    matrix.rows.every((row,index)=>row.browser===plan[index].browser&&row.example===plan[index].example&&
      row.status===0&&!row.signal&&!row.error&&!row.inputError&&row.complete===true&&
      row.passed===true&&row.inputsUnchanged===true)
}

export async function runTerminalRepeats(options,{inputs=terminalMatrixInputs,run=runTerminalMatrix,signal}={}){
  assert.ok(Number.isInteger(options.runs)&&options.runs>=2&&options.runs<=5,'Terminal repeats require 2..5 complete matrices')
  const output=mkdtempSync(join(tmpdir(),'native-site-terminal-repeats-'))
  const identity=inputs(options)
  const receipt={scope:'Repeated full real-site terminal matrices, fresh browser per cell, not a same-browser soak or strict error-free host acceptance.',
    output,runs:options.runs,identity,
    driverSHA256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    rows:[],complete:false,passed:false}
  const save=()=>writeFileSync(join(output,'results.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log('NATIVE_TERMINAL_REPEATS_REPORT '+join(output,'results.json'));save()
  try{
    for(let iteration=1;iteration<=options.runs;iteration++){
      if(signal?.aborted){receipt.interrupted=String(signal.reason);break}
      const matrix=await run({...options,runs:1},{signal})
      const row={iteration,output:matrix.output,passed:terminalRepeatOutcome(matrix),matrix}
      try{
        assert.deepEqual(matrix.identity,identity,'Terminal matrix inputs differ')
        assert.deepEqual(inputs(options),identity,'Terminal repeat inputs changed')
        row.inputsUnchanged=true
      }catch(error){row.passed=false;row.inputError=String(error)}
      receipt.rows.push(row);save()
      console.log('NATIVE_TERMINAL_REPEAT '+JSON.stringify({iteration,passed:row.passed,output:matrix.output}))
      if(row.inputError){receipt.stoppedReason='Terminal repeat inputs changed';break}
      // A failed full matrix stays failed. The next planned matrix is another
      // measurement, never a retry that replaces the earlier result.
    }
  }catch(error){receipt.runnerError=String(error)}
  if(signal?.aborted)receipt.interrupted=String(signal.reason)
  receipt.complete=receipt.rows.length===options.runs&&!receipt.runnerError&&!receipt.interrupted&&!receipt.stoppedReason
  receipt.passed=receipt.complete&&receipt.rows.every(row=>row.passed&&row.inputsUnchanged)
  save();return receipt
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const controller=new AbortController()
  const handlers=Object.fromEntries(['SIGINT','SIGTERM'].map(name=>[name,()=>controller.abort(Error(name))]))
  for(const [name,handler]of Object.entries(handlers))process.on(name,handler)
  try{
    const receipt=await runTerminalRepeats(terminalRepeatOptions(process.argv.slice(2)),{signal:controller.signal})
    if(!receipt.passed)process.exitCode=1
  }finally{for(const [name,handler]of Object.entries(handlers))process.removeListener(name,handler)}
}
