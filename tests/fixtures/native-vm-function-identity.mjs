export async function probeVMFunctionIdentity(Script){
  const script=new Script('(async function own(){return own})',{filename:'/app/self.js'})
  const first=script.runInThisContext(),second=script.runInThisContext()
  const recurse=new Script('(async function own(count){return count?own(count-1):own})',{filename:'/app/recursive.js'}).runInThisContext()
  const evaluate=new Script('(async function own(){return eval("own")})',{filename:'/app/eval-self.js'}).runInThisContext()
  return {
    fresh:first!==second,
    self:await first()===first,
    secondSelf:await second()===second,
    recursiveSelf:await recurse(2)===recurse,
    evalSelf:await evaluate()===evaluate,
    name:first.name,
    length:first.length,
  }
}

export function probeVMFunctionSource(Script){
  const functions=[
    'async function own(){return own}',
    'async function own( value ) { /* keep comment */ return value }',
    'async function own(value) {\n\t// keep indentation\n\treturn value\n}',
    'function own( x ) { /* keep */ return x + 1 }',
    'function own(){return {value:42}}',
    'x => x + 1', '() => ({value:42})', 'async () => 42',
    'async function* own(){yield 1;return 2}',
  ].map(source=>new Script('('+source+')',{filename:'/app/function-source.js'}).runInThisContext().toString())
  const values=[
    '(()=>({value:42}))()', '(()=> (1,2))()', '(()=>()=>42)()()',
    '(function(){return ()=>42})()()', '(()=>((({value:42}))))()',
    '"\\u0061"', '"a\\nb"', '"\\x61"', '"\\u{1F600}"',
    'try{1,2}finally{3,4}',
    'try{42}finally{try{7}finally{9}}', 'try{42}finally{while(false)7}',
  ].map(source=>new Script(source,{filename:'/app/nested-completion.js'}).runInThisContext())
  return {functions,values}
}
export const vmFunctionSourceSource=`import {Script} from 'node:vm';
  const probe=${probeVMFunctionSource.toString()};
  console.log(JSON.stringify(probe(Script)));`

export async function probeVMPersistentState(Script){
  const binding='__nativeVmIdentity_'+Math.random().toString(36).slice(2)
  new Script(`let ${binding}=1`,{filename:'/app/declaration.js'}).runInThisContext()
  const retained=new Script(`()=>${binding}`,{filename:'/app/retained.js'}).runInThisContext()
  new Script(`${binding}+=1`,{filename:'/app/increment.js'}).runInThisContext()
  const channels=()=>Object.getOwnPropertyNames(globalThis).filter(key=>key.startsWith('__tanstack_container_vm_completion_')).sort()
  const before=JSON.stringify(channels())
  let thrown
  try{new Script('throw new TypeError("owned failure")',{filename:'/app/throw.js'}).runInThisContext()}
  catch(error){thrown={name:error.name,message:error.message}}
  const recovery=binding+'_recovery'
  try{new Script(`let ${recovery}=3;throw new Error("after declaration")`,{filename:'/app/recovery.js'}).runInThisContext()}
  catch{}
  let redeclaration
  try{new Script(`let ${binding}=99`,{filename:'/app/redeclare.js'}).runInThisContext()}
  catch(error){redeclaration=error.name}
  const afterErrors=new Script(`${binding}+=1;${recovery}+${binding}`,{filename:'/app/after-errors.js'}).runInThisContext()
  return {
    retainedLexicalValue:retained(),
    thrown,
    completionChannelsReleased:JSON.stringify(channels())===before,
    completionChannelCount:channels().length,
    redeclaration,
    afterErrors,
  }
}

export const vmFunctionIdentitySource=`import {Script} from 'node:vm';
  const probe=${probeVMFunctionIdentity.toString()};
  console.log(JSON.stringify(await probe(Script)));`

export const vmPersistentStateSource=`import {Script} from 'node:vm';
  const probe=${probeVMPersistentState.toString()};
  console.log(JSON.stringify(await probe(Script)));`
