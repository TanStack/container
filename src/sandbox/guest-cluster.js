import {EventEmitter} from 'node:events'
import {fork as forkProcess} from 'node:child_process'
import process from 'node:process'

const unsupported=feature=>Object.assign(Error(feature+' is not supported in this browser sandbox'),{code:'ERR_UNSUPPORTED_OPERATION'})
export const SCHED_NONE=1,SCHED_RR=2
export let schedulingPolicy=SCHED_RR
export const isWorker=process.env.NODE_UNIQUE_ID!==undefined
export const isPrimary=!isWorker
export const isMaster=isPrimary
export const workers={}
export const settings={}
let nextId=1

export class Worker extends EventEmitter{
  constructor(id,child){super();this.id=id;this.process=child;this.exitedAfterDisconnect=false;this.state='none';this._online=false;this._messages=[]
    if(child){
      child.on('spawn',()=>{this.state='online';this._online=true;this.emit('online');cluster.emit('online',this);for(const args of this._messages)this._message(...args);this._messages=[]})
      child.on('message',(message,handle)=>{if(message?.cmd==='NODE_CLUSTER_LISTENING'){this.emit('listening',message.address);cluster.emit('listening',this,message.address);return}this._online?this._message(message,handle):this._messages.push([message,handle])})
      child.on('disconnect',()=>{this.state='disconnected';delete workers[this.id];this.emit('disconnect');cluster.emit('disconnect',this)})
      child.on('error',error=>this.emit('error',error))
      child.on('exit',(code,signal)=>{this.state='dead';delete workers[this.id];this.emit('exit',code,signal);cluster.emit('exit',this,code,signal)})
    }
  }
  _message(message,handle){this.emit('message',message,handle);cluster.emit('message',this,message,handle)}
  send(message,handle,options,callback){return this.process.send(message,handle,options,callback)}
  disconnect(){this.exitedAfterDisconnect=true;this.process.disconnect();return this}
  kill(signal='SIGTERM'){return this.process.kill(signal)}
  destroy(signal='SIGTERM'){return this.kill(signal)}
  isConnected(){return this.process.connected===true}
  isDead(){return this.state==='dead'||this.process.exitCode!==null||this.process.signalCode!==null}
}

const cluster=new EventEmitter()
const supported=new Set(['exec','args','execArgv','silent','serialization'])
export function setupPrimary(options={}){
  if(!isPrimary)throw unsupported('Cluster primary setup in a worker')
  if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Cluster settings must be an object')
  for(const key of Object.keys(options))if(!supported.has(key))throw unsupported('Cluster setup option '+key)
  if(options.exec!==undefined&&typeof options.exec!=='string')throw new TypeError('Cluster exec must be a string')
  for(const name of ['args','execArgv'])if(options[name]!==undefined&&(!Array.isArray(options[name])||options[name].some(value=>typeof value!=='string')))throw new TypeError('Cluster '+name+' must be an array of strings')
  if(options.serialization!==undefined&&!['json','advanced'].includes(options.serialization))throw new TypeError('Invalid serialization mode')
  Object.assign(settings,options)
  process.nextTick(()=>cluster.emit('setup',settings))
}
export const setupMaster=setupPrimary

export function fork(env={}){
  if(!isPrimary)throw unsupported('Forking cluster workers from a cluster worker')
  if(env===null||typeof env!=='object'||Array.isArray(env))throw new TypeError('Worker environment must be an object')
  const id=nextId++,entry=settings.exec??process.argv[1]
  if(typeof entry!=='string'||!entry)throw unsupported('Cluster entry file')
  const child=forkProcess(entry,settings.args??process.argv.slice(2),{execArgv:settings.execArgv??process.execArgv,env:{...process.env,...env,NODE_UNIQUE_ID:String(id)},silent:settings.silent??false,serialization:settings.serialization??'advanced'})
  const worker=new Worker(id,child);workers[id]=worker
  return worker
}

export function disconnect(callback){
  if(!isPrimary)throw unsupported('Disconnecting the cluster from a worker')
  const active=Object.values(workers)
  if(!active.length){if(callback)process.nextTick(callback);return}
  let remaining=active.length
  for(const worker of active){worker.once('disconnect',()=>{if(!--remaining)callback?.()});worker.disconnect()}
}

if(isWorker){
  const id=Number(process.env.NODE_UNIQUE_ID)
  const self=new Worker(id,process);self.state='online';self._online=true
  self.kill=()=>{process.exit(0);return true}
  self.destroy=self.kill
  self.disconnect=()=>{self.exitedAfterDisconnect=true;process.disconnect();return self}
  self.isConnected=()=>process.connected===true
  self.isDead=()=>false
  Object.defineProperty(cluster,'worker',{value:self,enumerable:true})
  globalThis.__webContainerClusterListening=address=>process.send({cmd:'NODE_CLUSTER_LISTENING',address})
  const servers=new Set()
  globalThis.__webContainerClusterServer=server=>{servers.add(server);server.once('close',()=>servers.delete(server))}
  process.once('disconnect',()=>{for(const server of servers)server.close()})
}

Object.assign(cluster,{Worker,workers,settings,setupPrimary,setupMaster,fork,disconnect,SCHED_NONE,SCHED_RR,isPrimary,isMaster,isWorker,schedulingPolicy})
Object.defineProperty(cluster,'schedulingPolicy',{get:()=>schedulingPolicy,set:value=>{if(value!==SCHED_NONE&&value!==SCHED_RR)throw new TypeError('Invalid scheduling policy');schedulingPolicy=value},enumerable:true})
export default cluster
