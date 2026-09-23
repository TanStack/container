import {formatWithOptions,inspect} from 'node:util'
import process from 'node:process'

function argument(message){return Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_TYPE'})}
export function Console(stdout,stderr,ignoreErrors=true){
  if(!(this instanceof Console))return new Console(stdout,stderr,ignoreErrors)
  let options={}
  if(stdout&&typeof stdout.write!=='function'){
    options=stdout;stdout=options.stdout;stderr=options.stderr;ignoreErrors=options.ignoreErrors??true
  }
  stderr??=stdout
  if(!stdout||typeof stdout.write!=='function')throw argument('Console expects a writable stdout stream')
  if(!stderr||typeof stderr.write!=='function')throw argument('Console expects a writable stderr stream')
  const inspectOptions={...options.inspectOptions}
  const counts=new Map,times=new Map
  let indent=''
  const write=(stream,args)=>{
    const colors=options.colorMode===true||(options.colorMode!==false&&Boolean(stream.isTTY))
    const value=indent+formatWithOptions({colors,...inspectOptions},...args).replace(/\n/g,'\n'+indent)+'\n'
    if(!ignoreErrors){stream.write(value);return}
    try{stream.write(value,error=>{if(error&&stream.listenerCount?.('error')===0)stream.once('error',()=>{})})}catch{}
  }
  // Own bound methods also work when destructured, as Node's Console methods do.
  this.log=(...args)=>write(stdout,args)
  this.info=this.log;this.debug=this.log
  this.error=(...args)=>write(stderr,args)
  this.warn=this.error
  this.dir=(value,settings)=>this.log(inspect(value,{customInspect:false,...inspectOptions,...settings}))
  this.dirxml=this.log
  this.assert=(condition,...args)=>{if(!condition)this.warn(args.length?'Assertion failed: '+formatWithOptions(inspectOptions,...args):'Assertion failed')}
  this.count=(label='default')=>{label=String(label);const value=(counts.get(label)??0)+1;counts.set(label,value);this.log(`${label}: ${value}`)}
  this.countReset=(label='default')=>{label=String(label);if(counts.has(label))counts.set(label,0)}
  this.group=(...args)=>{if(args.length)this.log(...args);indent+='  '}
  this.groupCollapsed=this.group
  this.groupEnd=()=>{indent=indent.slice(0,-2)}
  const now=()=>globalThis.performance?.now?.()??Date.now()
  const duration=value=>value<1000?`${Number(value.toFixed(3))}ms`:`${Number((value/1000).toFixed(3))}s`
  this.time=(label='default')=>{label=String(label);if(!times.has(label))times.set(label,now())}
  this.timeLog=(label='default',...args)=>{label=String(label);if(times.has(label))this.log(`${label}: ${duration(now()-times.get(label))}`,...args)}
  this.timeEnd=(label='default')=>{label=String(label);if(times.has(label)){this.timeLog(label);times.delete(label)}}
  this.trace=(...args)=>{const message=formatWithOptions(inspectOptions,...args);const error=new Error(message);error.name='Trace';this.error(error.stack??`Trace: ${message}`)}
  this.clear=()=>{if(stdout.isTTY)this.log('\u001b[1;1H\u001b[0J')}
  this.table=(data,properties)=>{
    if(data===null||typeof data!=='object'){this.log(data);return}
    if(properties!==undefined&&!Array.isArray(properties))throw argument('The properties argument must be an Array')
    const map=data instanceof Map,set=data instanceof Set
    const entries=map?[...data].map(([key,value],index)=>({key:index,value:{Key:key,Values:value}})):set?[...data].map((value,key)=>({key,value:{Values:value}})):Object.entries(data).map(([key,value])=>({key,value}))
    let columns=[]
    if(Array.isArray(properties))columns=properties.map(String)
    else for(const {value} of entries)if(value&&typeof value==='object')for(const key of Object.keys(value))if(!columns.includes(key))columns.push(key)
    const hasScalar=entries.some(({value})=>value===null||typeof value!=='object')
    const headers=[map||set?'(iteration index)':'(index)',...columns,...hasScalar?['Values']:[]]
    const rows=entries.map(({key,value})=>{
      const row=[String(key)]
      for(const column of columns)row.push(value&&typeof value==='object'&&column in value?inspect(value[column],{colors:false,...inspectOptions}):'')
      if(hasScalar)row.push(value===null||typeof value!=='object'?inspect(value,{colors:false,...inspectOptions}):'')
      return row
    })
    const widths=headers.map((header,index)=>Math.max(header.length,...rows.map(row=>String(row[index]??'').length)))
    const line=(left,middle,right,char)=>left+widths.map(width=>char.repeat(width+2)).join(middle)+right
    const row=values=>'│ '+values.map((value,index)=>String(value??'').padEnd(widths[index])).join(' │ ')+' │'
    this.log([line('┌','┬','┐','─'),row(headers),line('├','┼','┤','─'),...rows.map(row),line('└','┴','┘','─')].join('\n'))
  }
}
const instance=new Console({stdout:process.stdout,stderr:process.stderr})
instance.Console=Console
const noop=()=>{}
const inspectorContext=Object.fromEntries(['dir','dirXml','table','groupEnd','clear','count','countReset','profile','profileEnd','debug','error','info','log','warn','trace','group','groupCollapsed','assert','time','timeLog','timeEnd','timeStamp'].map(name=>[name,noop]))
export const context=()=>({...inspectorContext}),profile=noop,profileEnd=noop,timeStamp=noop
export const createTask=(name)=>{
  if(typeof name!=='string'||name.length===0)throw Error('First argument must be a non-empty string.')
  return{run(task){if(typeof task!=='function')throw Error('First argument must be a function.');return task()}}
}
instance.context=context;instance.profile=profile;instance.profileEnd=profileEnd;instance.timeStamp=timeStamp;instance.createTask=createTask
export const {log,info,debug,error,warn,dir,dirxml,assert,clear,count,countReset,group,groupCollapsed,groupEnd,table,time,timeEnd,timeLog,trace}=instance
export default instance
