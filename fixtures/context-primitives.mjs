// Trusted engine test harness, not an implementation of node:vm contexts.
export const policyCases=[
    ['direct eval','eval("1")'],
    ['indirect eval','(0,eval)("1")'],
    ['aliased eval','(()=>{const e=eval;return e("1")})()'],
    ['bound eval','eval.bind(null)("1")'],
    ['reflect eval','Reflect.apply(eval,null,["1"])'],
    ['Function constructor','Function("return 1")'],
    ['new Function','new Function("return 1")'],
    ['function constructor alias','(()=>{}).constructor("return 1")'],
    ['generator constructor','(function*(){}).constructor("yield 1")'],
    ['async constructor','(async()=>{}).constructor("return 1")'],
    ['async generator constructor','(async function*(){}).constructor("yield 1")'],
    ['subclass constructor','new (class F extends Function {})("return 1")'],
    ['policy precedes invalid source syntax','eval("(")'],
    ['policy blocks non-string eval','eval(42)'],
    ['policy blocks empty eval','eval()'],
    ['policy blocks indirect non-string eval','(0,eval)(42)'],
    ['policy blocks boxed string eval','(()=>{const s=new String("1");return eval(s)===s})()'],
    ['constructor coercion still runs','(()=>{let calls=0;try{Function({toString(){calls++;return "return 1"}})}catch(e){return [calls,e.name]}})()'],
    ['throwing constructor coercion','Function({toString(){throw new RangeError("coercion")}})'],
    ['ordinary functions remain callable','(()=>42)()'],
    ['JSON parser remains usable','JSON.parse("{\\"answer\\":42}").answer'],
    ['policy errors use the realm EvalError prototype','(()=>{try{eval("1")}catch(e){return [e instanceof EvalError,e instanceof Error,Object.getPrototypeOf(e)===EvalError.prototype]}})()'],
    ['policy cannot be reset through a global property','(()=>{globalThis.__qjsDisableStringCodeGeneration=()=>false;globalThis.__qjsDisableStringCodeGeneration();return eval("1")})()'],
  ]

export function probeContextPrimitives(engine,bootstrap,reference){
const runtime=engine.newRuntime()
runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024)
const deadline=Date.now()+5000
runtime.setInterruptHandler(()=>Date.now()>deadline)
const contexts=[],handles=[],rows=[]
const context=options=>{const value=runtime.newContext(options);contexts.push(value);return value}
const evaluate=(ctx,source)=>{const value=ctx.unwrapResult(ctx.evalCode(source));handles.push(value);return value}
const value=(ctx,source)=>ctx.dump(evaluate(ctx,source))
const record=(name,actual,expected,kind='primitive')=>rows.push({name,actual,expected,matches:JSON.stringify(actual)===JSON.stringify(expected),kind})
try{
  const parent=context(),child=context()
  evaluate(parent,`globalThis.marker='parent'`)
  record('separate globals',value(child,`typeof marker`),'undefined')
  const shared=evaluate(parent,`({value:1})`)
  parent.setProp(parent.global,'shared',shared);child.setProp(child.global,'shared',shared)
  evaluate(child,`shared.value=42`)
  record('explicit shared object identity',value(parent,`shared.value`),42)
  child.setProp(child.global,'parentArray',evaluate(parent,'Array'))
  record('separate realm intrinsics',value(child,'Array===parentArray'),false)
  evaluate(child,'let persistent=40');record('persistent lexical scope',value(child,'persistent+=2'),42)

  evaluate(parent,bootstrap);evaluate(child,bootstrap)
  const storage=evaluate(parent,'globalThis.storage=new __engineAsyncLocalStorage()')
  child.setProp(child.global,'storage',storage)
  const promises=[
    [parent,evaluate(parent,`storage.run('parent',async()=>{await 0;await 0;return storage.getStore()})`)],
    [child,evaluate(child,`storage.run('child',async()=>{await 0;return storage.getStore()})`)],
  ]
  while(runtime.hasPendingJob()){
    const jobs=runtime.executePendingJobs(100)
    try{if(jobs.error)throw Error(JSON.stringify(parent.dump(jobs.error)))}finally{jobs.dispose()}
  }
  const values=promises.map(([ctx,promise])=>{
    const state=ctx.getPromiseState(promise)
    if(state.type!=='fulfilled')throw Error('Context promise did not fulfill')
    try{return ctx.dump(state.value)}finally{state.value.dispose()}
  })
  record('shared scheduler retains cross-context ALS',values,['parent','child'])

  const task=evaluate(child,`async function task(gate){const before=storage.getStore();await gate;await 0;return [before,storage.getStore()]}task`)
  parent.setProp(parent.global,'childTask',task)
  const concurrent=evaluate(parent,`(()=>{
    let release;const gate=new Promise(resolve=>release=resolve);
    const a=storage.run('a',()=>childTask(gate)),b=storage.run('b',()=>childTask(gate));
    storage.run('resolver',release);return Promise.all([a,b]);
  })()`)
  while(runtime.hasPendingJob()){
    const jobs=runtime.executePendingJobs(100)
    try{if(jobs.error)throw Error(JSON.stringify(parent.dump(jobs.error)))}finally{jobs.dispose()}
  }
  const concurrentState=parent.getPromiseState(concurrent)
  if(concurrentState.type!=='fulfilled')throw Error('Cross-context tasks did not fulfill')
  try{record('overlapping parent ALS survives child native awaits',parent.dump(concurrentState.value),[['a','a'],['b','b']])}finally{concurrentState.value.dispose()}

  parent.setProp(parent.global,'childSpin',evaluate(child,`(()=>{const start=Date.now();while(Date.now()-start<100){};return 'escaped'})`))
  const timed=evaluate(parent,`(()=>{const run=__qjsCompileScript('childSpin()','cross-context.js',0,0);try{return run(10)}catch(e){return e.code}})()`)
  record('script timeout follows calls into another context',parent.dump(timed),reference.timeout)

  parent.setProp(parent.global,'childRun',evaluate(child,`__qjsCompileScript('(()=>{const start=Date.now();while(Date.now()-start<100){};return "finished"})()','child.js',0,0)`))
  for(const [name,outer,inner] of [['outer',10,1000],['inner',1000,10]]){
    const source=`try{childRun(${inner})}catch(e){[e.code,'inner']}`
    const result=value(parent,`(()=>{const run=__qjsCompileScript(${JSON.stringify(source)},'parent.js',0,0);try{return run(${outer})}catch(e){return [e.code,'outer']}})()`)
    record('nested cross-context '+name+' timeout',result,reference.nested[name])
  }
  record('context recovers after cross-context timeouts',value(parent,'40+2'),42)
  const raced=value(parent,`(()=>{
    const run=__qjsCompileScript('try{childRun(1)}catch(e){"inner"}','race.js',0,0),counts={};
    for(let index=0;index<100;index++){
      let result;try{result=run(1)}catch(error){result=error.code==='ERR_SCRIPT_EXECUTION_TIMEOUT'?'outer':error.name}
      counts[result]=(counts[result]??0)+1;
    }
    return counts;
  })()`)
  record('equal nested deadlines cannot be swallowed by an inner catch',raced,reference.sameDeadline)

  const noEval=context()
  const compile=evaluate(noEval,'__qjsCompileScript')
  const disable=evaluate(noEval,'__qjsDisableStringCodeGeneration')
  noEval.unwrapResult(noEval.callFunction(disable,noEval.undefined)).dispose()
  evaluate(noEval,'delete globalThis.__qjsCompileScript;delete globalThis.__qjsDisableStringCodeGeneration')
  record('disabled string generation still permits host evaluation',value(noEval,'1+1'),reference.hostEvaluation)
  for(const [name,expression] of policyCases){
    const source=`(()=>{try{return {value:${expression}}}catch(e){return {error:e.name}}})()`
    record(name,value(noEval,source),reference.policy[name],'code-generation-policy')
  }
  const args=[noEval.newString('let magic=40;magic+=2'),noEval.newString('policy.js'),noEval.newNumber(0),noEval.newNumber(0)]
  try{
    const runner=noEval.unwrapResult(noEval.callFunction(compile,noEval.undefined,...args))
    try{
      const answer=noEval.unwrapResult(noEval.callFunction(runner,noEval.undefined))
      try{record('host compiled script runs under disabled policy',noEval.dump(answer),reference.compiled)}finally{answer.dispose()}
    }finally{runner.dispose()}
  }finally{args.forEach(arg=>arg.dispose())}
  record('compiled script retains context lexical scope',value(noEval,'magic'),reference.lexical)
  record('policy does not disable another context',value(parent,'eval("40+2")'),42)
  parent.setProp(parent.global,'restrictedEval',evaluate(noEval,'eval'))
  const escaped=`(()=>{try{return restrictedEval('42')}catch(e){return e.name}})()`
  record('restricted eval keeps policy when called from another context',value(parent,escaped),reference.escaped)
}finally{
  handles.reverse().forEach(handle=>handle.dispose())
  contexts.reverse().forEach(ctx=>ctx.dispose());runtime.dispose()
}
return rows
}
