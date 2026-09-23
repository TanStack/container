import process from 'node:process'

const key=Symbol.for('web-container:node-test')
const state=globalThis[key]??={root:{name:'',parent:null,children:[],hooks:{before:[],after:[],beforeEach:[],afterEach:[]}},current:null,scheduled:false,running:false}
globalThis[key]=state;state.current??=state.root
const optionKeys=new Set(['skip','todo','only'])
function argumentsFor(name,options,fn){
  if(typeof name==='function')return {name:name.name||'<anonymous>',options:{},fn:name}
  if(typeof name!=='string')throw new TypeError('Test name must be a string')
  if(typeof options==='function'||options===undefined)return {name,options:{},fn:options}
  if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Test options must be an object')
  for(const key of Object.keys(options))if(!optionKeys.has(key))throw Object.assign(Error('Unsupported test option '+key),{code:'ERR_UNSUPPORTED_OPERATION'})
  return {name,options,fn}
}
const selected=(node,ancestorOnly=false)=>ancestorOnly||node.only||node.children?.some(child=>selected(child))
const hasOnly=node=>node.only||node.children?.some(hasOnly)
// The process runner does not expose the enclosing ESM evaluation promise.
// A task boundary safely collects ordinary synchronous declarations, but it
// cannot know when an async describe callback has finished registering tests.
function schedule(){if(state.scheduled)return;state.scheduled=true;setTimeout(()=>run().catch(error=>{console.error(String(error));process.exitCode=1}),0)}
function add(kind,name,options,fn){
  const parsed=argumentsFor(name,options,fn),parent=state.current
  if(kind==='suite'){
    if(typeof parsed.fn!=='function')throw new TypeError('Suite callback must be a function')
    const suite={kind,name:parsed.name,parent,children:[],hooks:{before:[],after:[],beforeEach:[],afterEach:[]},skip:Boolean(parsed.options.skip),todo:Boolean(parsed.options.todo),only:Boolean(parsed.options.only)}
    parent.children.push(suite);const previous=state.current;state.current=suite
    try{const result=parsed.fn();if(result&&typeof result.then==='function')throw Object.assign(Error('Async suite registration is not supported'),{code:'ERR_UNSUPPORTED_OPERATION'})}finally{state.current=previous}
  }else{
    if(!parsed.options.todo&&typeof parsed.fn!=='function')throw new TypeError('Test callback must be a function')
    parent.children.push({kind,name:parsed.name,parent,fn:parsed.fn,skip:Boolean(parsed.options.skip),todo:Boolean(parsed.options.todo),only:Boolean(parsed.options.only)})
  }
  schedule()
}
function api(kind){
  const value=(name,options,fn)=>add(kind,name,options,fn)
  value.skip=(name,options,fn)=>add(kind,name,{...(typeof options==='object'&&options||{}),skip:true},typeof options==='function'?options:fn)
  value.todo=(name,options,fn)=>add(kind,name,{...(typeof options==='object'&&options||{}),todo:true},typeof options==='function'?options:fn)
  value.only=(name,options,fn)=>add(kind,name,{...(typeof options==='object'&&options||{}),only:true},typeof options==='function'?options:fn)
  return value
}
export const test=api('test'),it=test,describe=api('suite'),suite=describe
const hook=name=>(fn)=>{if(typeof fn!=='function')throw new TypeError('Hook must be a function');state.current.hooks[name].push(fn)}
export const before=hook('before'),after=hook('after'),beforeEach=hook('beforeEach'),afterEach=hook('afterEach')

async function call(fn,context){return await fn(context)}
async function run(){
  if(state.running)return;state.running=true
  const rows=[],only=hasOnly(state.root),root=state.root
  const visit=async(node,ancestors=[],forcedSkip=false,ancestorOnly=false)=>{
    if(node.kind==='suite'){
      if(only&&!selected(node,ancestorOnly))return
      const skipped=forcedSkip||node.skip||node.todo,next=[...ancestors,node]
      if(!skipped)for(const fn of node.hooks.before)await call(fn,{})
      for(const child of node.children)await visit(child,next,skipped,ancestorOnly||node.only)
      if(!skipped)for(const fn of node.hooks.after)await call(fn,{})
      return
    }
    if(only&&!selected(node,ancestorOnly))return
    const row={name:node.name,status:'pass',directive:''}
    if(forcedSkip||node.skip){row.status='skip';row.directive='SKIP'}
    else if(node.todo){
      row.status='todo';row.directive='TODO'
      try{for(const scope of ancestors)for(const fn of scope.hooks.beforeEach)await call(fn,{});if(node.fn)await call(node.fn,{})}finally{for(const scope of [...ancestors].reverse())for(const fn of scope.hooks.afterEach)await call(fn,{})}
    }else try{
      const context={skip(){throw {directive:'SKIP'}},todo(){throw {directive:'TODO'}}}
      for(const scope of ancestors)for(const fn of scope.hooks.beforeEach)await call(fn,context)
      try{await call(node.fn,context)}finally{for(const scope of [...ancestors].reverse())for(const fn of scope.hooks.afterEach)await call(fn,context)}
    }catch(error){if(error?.directive){row.status=error.directive.toLowerCase();row.directive=error.directive}else{row.status='fail';row.error=error}}
    rows.push(row)
  }
  for(const child of root.children)await visit(child)
  console.log('TAP version 13')
  rows.forEach((row,index)=>{
    console.log(`${row.status==='fail'?'not ok':'ok'} ${index+1} - ${row.name}${row.directive?' # '+row.directive:''}`)
    if(row.error){console.log('  ---');console.log(`  name: ${row.error.name||'Error'}`);console.log(`  message: ${JSON.stringify(String(row.error.message??row.error))}`);if(row.error.code)console.log(`  code: ${row.error.code}`);console.log('  ...')}
  })
  const failed=rows.filter(row=>row.status==='fail').length
  console.log(`1..${rows.length}`);console.log(`# tests ${rows.length}`);console.log(`# pass ${rows.filter(row=>row.status==='pass').length}`);console.log(`# fail ${failed}`);console.log(`# skipped ${rows.filter(row=>row.status==='skip').length}`);console.log(`# todo ${rows.filter(row=>row.status==='todo').length}`)
  if(failed)process.exitCode=1
}
// Builtins expose their default value to require(), and the ESM bridge reads
// named exports from that same value. Node's callable test export owns these
// APIs too, so preserve both import styles on the same object.
Object.assign(test,{test,it,describe,suite,before,after,beforeEach,afterEach})
export default test
