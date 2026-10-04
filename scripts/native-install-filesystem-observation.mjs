// Opt-in worker observation. Time only the public synchronous file operations
// used by installation, never inspect their arguments, paths or return values.
export function installNativeInstallFilesystemObservation(){
  const post=self.postMessage
  let provider,restorations=[],active=false,operations={}
  const start=()=>{
    provider=self[Symbol.for('tanstack-container:filesystem-provider-v1')]
    if(!provider?.vol)return
    active=true
    for(const name of ['lstatSync','mkdirSync','writeFileSync','writeFileWithParentsSync']){
      const original=provider.vol[name]
      if(typeof original!=='function')continue
      const wrapper=function(...args){
        const started=performance.now()
        let failed=false
        try{return Reflect.apply(original,this,args)}
        catch(error){failed=true;throw error}
        finally{
          const row=operations[name]??={count:0,totalMs:0,maxMs:0,errors:0}
          const ms=performance.now()-started
          row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms)
          if(failed)row.errors++
        }
      }
      provider.vol[name]=wrapper
      restorations.push(()=>{if(provider.vol[name]===wrapper)provider.vol[name]=original})
    }
  }
  const summary=()=>{
    try{console.info('INSTALL_FILESYSTEM_SUMMARY '+JSON.stringify({provider:!!provider,active,operations}))}catch{}
  }
  self.postMessage=function(message,...args){
    if(message?.type==='native-dev-progress'){
      if(message.phase==='dependencies-install-started'&&!active){
        operations={}
        try{start()}catch{}
      }
      if(active&&(/^dependency-installed:(?:[2-9]\d|\d{3,})\/\d+$/.test(message.phase)||message.phase==='dependencies-installed')){
        // Package-level messages are bounded by the install plan. Sample every
        // 20 completed packages, then once at completion, no polling timer.
        const completed=Number(message.phase.split(':')[1]?.split('/')[0])
        if(message.phase==='dependencies-installed'||completed%20===0)summary()
      }
      if(message.phase==='dependencies-installed'){
        for(const restore of restorations){try{restore()}catch{}}
        restorations=[];active=false
      }
    }
    return Reflect.apply(post,this,[message,...args])
  }
}
