import domain from 'node:domain'
import {EventEmitter} from 'node:events'
const outer=domain.create(),inner=domain.create(),trace=[],errors=[]
outer.on('error',error=>errors.push(error.message))
outer.run(()=>{trace.push(domain.active===outer);inner.run(()=>trace.push(domain.active===inner));trace.push(domain.active===outer)})
const bound=outer.bind(value=>{trace.push(domain.active===outer);return value+1})
trace.push(bound(2))
const intercepted=outer.intercept(value=>{trace.push(domain.active===outer);return value*2})
trace.push(intercepted(null,3));intercepted(Error('intercepted'))
const member=new EventEmitter();outer.add(member);member.emit('error',Error('member'));outer.remove(member)
const promised=await outer.run(async()=>{await Promise.resolve();return 9})
console.log(JSON.stringify({trace,errors,promised,memberDomain:member.domain??null}))
