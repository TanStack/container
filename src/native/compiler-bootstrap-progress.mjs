const reporterKey=Symbol.for('tanstack.container.compiler-bootstrap-progress')

export function installCompilerBootstrapReporter(reporter){
  if(typeof reporter!=='function')throw new TypeError('Compiler bootstrap reporter must be a function')
  if(globalThis[reporterKey]!==undefined)throw new Error('Compiler bootstrap reporter already installed')
  globalThis[reporterKey]=reporter
  return ()=>{if(globalThis[reporterKey]===reporter)delete globalThis[reporterKey]}
}

// Startup metadata must not replace the compiler's result or failure.
export function reportCompilerBootstrap(phase){
  try{globalThis[reporterKey]?.('rolldown:'+phase)}catch{}
}

export function observeCompilerBootstrapWorker(worker,id){
  reportCompilerBootstrap('worker-created:'+id)
  const release=()=>{
    worker.removeEventListener('message',message)
    worker.removeEventListener('error',error)
    worker.removeEventListener('messageerror',error)
  }
  const message=event=>{
    const data=event.data?.__emnapi__
    if(data?.type==='loaded'){
      release();reportCompilerBootstrap('worker-ready:'+id)
    }else if(data?.type==='thread-error'&&data.payload?.phase==='load'){
      release();reportCompilerBootstrap('worker-load-error:'+id)
    }
  }
  const error=()=>{release();reportCompilerBootstrap('worker-load-error:'+id)}
  worker.addEventListener('message',message)
  worker.addEventListener('error',error)
  worker.addEventListener('messageerror',error)
}
