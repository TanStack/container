import {it,expect} from 'vitest'
import {readFileSync,mkdtempSync,writeFileSync,watchFile,unwatchFile,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter} from 'node:events'
const source=readFileSync('src/sandbox/guest-fs-watch.js','utf8')
const {createStatWatchAPI,createPromiseWatch}=new Function(source+';return {createStatWatchAPI,createPromiseWatch}')()
it('polling observes the same normal size transition as native watchFile',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'stat-watch-')),file=join(dir,'file');writeFileSync(file,'a')
 const fs=await import('node:fs')
 const api=createStatWatchAPI({EventEmitter,statSync:fs.statSync,resolvePath:(v:string)=>v,makeStats:(v:unknown)=>v})
 try{
  const observe=(watch:any,unwatch:any)=>{
   let seen=0,readyResolve!:()=>void,resultResolve!:(value:number[])=>void
   const ready=new Promise<void>(resolve=>{readyResolve=resolve}),result=new Promise<number[]>(resolve=>{resultResolve=resolve})
   const watcher=watch(file,{interval:10},(current:any,previous:any)=>{if(++seen===1)readyResolve();else{unwatch(file);resultResolve([current.size,previous.size])}})
   expect(watcher.unref()).toBe(watcher);expect(watcher.ref()).toBe(watcher)
   return {ready,result}
  }
  const native=observe(watchFile,unwatchFile),guest=observe(api.watchFile,api.unwatchFile)
  writeFileSync(file,'aa')
  await Promise.all([native.ready,guest.ready])
  writeFileSync(file,'longer')
  expect(await guest.result).toEqual(await native.result)
 }finally{unwatchFile(file);api.unwatchFile(file);rmSync(dir,{recursive:true})}
})
it('promise watches deliver events, close on return, reject abort and bound queued events',async()=>{
 let watcher:any
 const watch=createPromiseWatch((_path:string,_options:any,callback:any)=>{watcher=new EventEmitter();watcher.close=()=>watcher.emit('close');watcher.on('change',callback);return watcher})
 const iterator=watch('/file'),pending=iterator.next();watcher.emit('change','change','file')
 expect(await pending).toEqual({done:false,value:{eventType:'change',filename:'file'}})
 await iterator.return();expect(await iterator.next()).toEqual({done:true,value:undefined})
 const controller=new AbortController(),aborted=watch('/file',{signal:controller.signal}),reading=aborted.next()
 controller.abort();await expect(reading).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR'})
 const bounded=watch('/file',{maxQueue:1});watcher.emit('change','change','file');watcher.emit('change','change','file')
 await expect(bounded.next()).rejects.toMatchObject({code:'ERR_FS_WATCH_QUEUE_OVERFLOW'})
})
it('native promise watch uses AbortError with ABORT_ERR for pending reads',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'promise-watch-')),controller=new AbortController()
 try{
  const {watch}=await import('node:fs/promises'),iterator=watch(dir,{signal:controller.signal}),pending=iterator.next()
  controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR'})
 }finally{rmSync(dir,{recursive:true})}
})
