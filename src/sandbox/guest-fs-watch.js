function createStatWatchAPI({EventEmitter,statSync,resolvePath,makeStats}){
 const watchers=new Map()
 const empty=options=>makeStats(Object.fromEntries(['dev','ino','mode','nlink','uid','gid','rdev','size','blksize','blocks','atimeMs','mtimeMs','ctimeMs','birthtimeMs'].map(key=>[key,0])),options)
 const sample=(path,options)=>{try{return statSync(path,{bigint:options.bigint})}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;return empty(options)}}
 class StatWatcher extends EventEmitter {
  constructor(path,options){
   super();this.path=path;this.options=options;this.closed=false;this.previous=sample(path,options)
   this.timer=setInterval(()=>{
    if(this.closed)return
    try{
     const current=sample(path,options),previous=this.previous
     this.previous=current
     if(['mtimeMs','ctimeMs','size','ino','nlink','mode'].some(key=>current[key]!==previous[key])||(!this.initial&&current.nlink==0))this.emit('change',current,previous)
     this.initial=true
    }catch(error){this.stop();this.emit('error',error)}
   },options.interval)
   if(options.persistent===false)this.unref()
  }
  ref(){this.timer.ref();return this}
  unref(){this.timer.unref();return this}
  stop(){if(this.closed)return;this.closed=true;clearInterval(this.timer);watchers.delete(this.path);queueMicrotask(()=>this.emit('stop'))}
 }
 function watchFile(filename,options,listener){
  if(typeof options==='function'){listener=options;options={}}
  options={interval:5007,persistent:true,...options}
  if(typeof listener!=='function')throw new TypeError('Expected watchFile listener')
  if(!Number.isInteger(options.interval)||options.interval<1||options.interval>2147483647)throw new RangeError('Invalid watchFile interval')
  for(const key of Object.keys(options))if(!['interval','persistent','bigint'].includes(key))throw Object.assign(Error('Unsupported watchFile option '+key),{code:'ERR_UNSUPPORTED_OPERATION'})
  const path=resolvePath(filename)
  let watcher=watchers.get(path)
  if(!watcher){if(watchers.size>=256)throw Object.assign(Error('Stat watcher limit exceeded'),{code:'ERR_RESOURCE_LIMIT'});watcher=new StatWatcher(path,options);watchers.set(path,watcher)}
  watcher.on('change',listener);return watcher
 }
 function unwatchFile(filename,listener){
  if(listener!==undefined&&typeof listener!=='function')throw new TypeError('Expected watchFile listener')
  const watcher=watchers.get(resolvePath(filename));if(!watcher)return
  if(listener)watcher.removeListener('change',listener);else watcher.removeAllListeners('change')
  if(!watcher.listenerCount('change'))watcher.stop()
 }
 return {StatWatcher,watchFile,unwatchFile}
}

function createPromiseWatch(watch){
 return function promiseWatch(path,options={}){
  if(typeof options==='string')options={encoding:options}
  options??={}
  if(typeof options!=='object'||Array.isArray(options))throw new TypeError('Expected watch options')
  for(const key of Object.keys(options))if(!['encoding','persistent','recursive','signal','maxQueue','overflow'].includes(key))throw Object.assign(Error('Unsupported watch option '+key),{code:'ERR_UNSUPPORTED_OPERATION'})
  const limit=options.maxQueue??256
  if(!Number.isInteger(limit)||limit<1||limit>256)throw new RangeError('watch maxQueue must be between 1 and 256')
  if(options.overflow!==undefined&&options.overflow!=='throw')throw Object.assign(Error('Only throwing watch overflow is supported'),{code:'ERR_UNSUPPORTED_OPERATION'})
  const signal=options.signal
  if(signal!==undefined&&typeof signal?.addEventListener!=='function')throw new TypeError('Expected AbortSignal')
  let watcher,ended=false,failure
  const queue=[],pending=[]
  const finish=error=>{
   if(ended)return
   ended=true;failure=error;queue.length=0;signal?.removeEventListener('abort',abort);watcher?.close()
   for(const entry of pending.splice(0))error?entry.reject(error):entry.resolve({done:true,value:undefined})
  }
  const abort=()=>finish(Object.assign(Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR',cause:signal.reason}))
  if(signal?.aborted)abort()
  else{
   watcher=watch(path,{...options,signal:undefined},(eventType,filename)=>{
    if(ended)return
    const value={eventType,filename},entry=pending.shift()
    if(entry)entry.resolve({done:false,value})
    else if(queue.length>=limit)finish(Object.assign(Error('Filesystem watch queue overflow'),{code:'ERR_FS_WATCH_QUEUE_OVERFLOW'}))
    else queue.push(value)
   })
   watcher.on('error',finish);watcher.on('close',()=>finish())
   signal?.addEventListener('abort',abort,{once:true})
   if(signal?.aborted)abort()
  }
  return {
   [Symbol.asyncIterator](){return this},
   next(){if(failure)return Promise.reject(failure);if(queue.length)return Promise.resolve({done:false,value:queue.shift()});if(ended)return Promise.resolve({done:true,value:undefined});if(pending.length>=256)return Promise.reject(Object.assign(Error('Too many pending watch reads'),{code:'ERR_RESOURCE_LIMIT'}));return new Promise((resolve,reject)=>pending.push({resolve,reject}))},
   return(){finish();return Promise.resolve({done:true,value:undefined})},
   throw(error){finish(error);return Promise.reject(error)},
  }
 }
}
