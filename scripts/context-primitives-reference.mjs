import vm from 'node:vm'
import {policyCases} from '../fixtures/context-primitives.mjs'

export function contextPrimitiveReference(){
  const context=vm.createContext(undefined,{codeGeneration:{strings:false,wasm:false}})
  const policy={}
  for(const [name,expression] of policyCases){
    policy[name]=vm.runInContext(`(()=>{try{return {value:${expression}}}catch(e){return {error:e.name}}})()`,context)
  }
  const spin=vm.createContext({childSpin:vm.runInNewContext(`(()=>{const start=Date.now();while(Date.now()-start<100){};return 'escaped'})`)})
  let timeout
  try{timeout=vm.runInContext('childSpin()',spin,{timeout:10})}catch(error){timeout=error.code}
  const parent=vm.createContext({restrictedEval:vm.runInContext('eval',context)})
  const nested={}
  for(const [name,outer,inner] of [['outer',10,1000],['inner',1000,10]]){
    const child=vm.createContext()
    const compiled=new vm.Script('(()=>{const start=Date.now();while(Date.now()-start<100){};return "finished"})()')
    const parent=vm.createContext({childRun:()=>compiled.runInContext(child,{timeout:inner})})
    try{nested[name]=vm.runInContext(`try{childRun()}catch(e){[e.code,'inner']}`,parent,{timeout:outer})}catch(error){nested[name]=[error.code,'outer']}
  }
  const raceChild=vm.createContext(),raceInner=new vm.Script('for(;;){}')
  const raceParent=vm.createContext({childRun:()=>raceInner.runInContext(raceChild,{timeout:1})})
  const raceOuter=new vm.Script('try{childRun()}catch(e){"inner"}'),sameDeadline={}
  for(let index=0;index<100;index++){
    let result;try{result=raceOuter.runInContext(raceParent,{timeout:1})}catch(error){result=error.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'?'outer':error.name}
    sameDeadline[result]=(sameDeadline[result]??0)+1
  }
  return {
    node:process.version,policy,timeout,nested,sameDeadline,
    hostEvaluation:vm.runInContext('1+1',context),
    compiled:new vm.Script('let magic=40;magic+=2').runInContext(context),
    lexical:vm.runInContext('magic',context),
    escaped:vm.runInContext(`(()=>{try{return restrictedEval('42')}catch(e){return e.name}})()`,parent),
  }
}
