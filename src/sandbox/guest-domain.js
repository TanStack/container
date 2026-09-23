import {EventEmitter} from 'node:events'
import {AsyncLocalStorage} from 'node:async_hooks'

const context=new AsyncLocalStorage()
const memberErrors=new WeakMap()
const stack=[]
export let active=null

export class Domain extends EventEmitter {
  constructor(){super();this.members=[];this.disposed=false}
  enter(){if(this.disposed)return;stack.push(active);active=this;context.enterWith(this)}
  exit(){if(active!==this)return;active=stack.pop()??null;context.enterWith(active)}
  run(fn,...args){
    if(typeof fn!=='function')throw Object.assign(new TypeError('fn must be a function'),{code:'ERR_INVALID_ARG_TYPE'})
    if(this.disposed)return Reflect.apply(fn,this,args)
    return context.run(this,()=>{this.enter();try{return Reflect.apply(fn,this,args)}finally{this.exit()}})
  }
  add(member){
    if((typeof member!=='object'&&typeof member!=='function')||member===null)return
    if(member.domain&&member.domain!==this)member.domain.remove(member)
    if(!this.members.includes(member))this.members.push(member)
    try{member.domain=this}catch{}
    if(typeof member.on==='function'){
      const route=error=>this.emit('error',error)
      memberErrors.set(member,route);member.on('error',route)
    }
  }
  remove(member){
    const index=this.members.indexOf(member);if(index>=0)this.members.splice(index,1)
    const route=memberErrors.get(member);if(route&&typeof member.removeListener==='function')member.removeListener('error',route)
    memberErrors.delete(member)
    try{if(member?.domain===this)member.domain=null}catch{}
  }
  bind(callback){
    if(typeof callback!=='function')throw Object.assign(new TypeError('callback must be a function'),{code:'ERR_INVALID_ARG_TYPE'})
    const domain=this
    return function(...args){
      try{return context.run(domain,()=>{domain.enter();try{return Reflect.apply(callback,this,args)}finally{domain.exit()}})}
      catch(error){if(error&&typeof error==='object'){error.domain=domain;error.domainThrown=true;error.domainBound=callback}domain.emit('error',error)}
    }
  }
  intercept(callback){
    if(typeof callback!=='function')throw Object.assign(new TypeError('callback must be a function'),{code:'ERR_INVALID_ARG_TYPE'})
    const domain=this
    return function(error,...args){if(error){if(typeof error==='object')error.domain=domain;domain.emit('error',error);return}return domain.bind(callback).apply(this,args)}
  }
  dispose(){
    if(this.disposed)return
    while(this.members.length)this.remove(this.members[this.members.length-1])
    while(active===this)this.exit()
    this.disposed=true;this.removeAllListeners()
  }
}
export const create=()=>new Domain()
export default {Domain,create,get active(){return active}}
