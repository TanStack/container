import type {NativeFileOperations} from './filesystem-operations'
type WatchedFilesystem=NativeFileOperations & {
  watch(path:string,options:{recursive:boolean},callback:(event:string,filename:unknown)=>void):{close():unknown}
}

/** Turn raw volume notifications into changes to observed filesystem state. */
export function observeWorkspaceEvents(volume:WatchedFilesystem,root:string,emit:(event:'change'|'rename',path:string)=>void){
  const states=new Map<string,string>()
  function signature(path:string){
    try{
      const stat=volume.lstatSync(path)
      if(stat.isDirectory())return 'directory:'+stat.ino+':'+stat.mode
      if(stat.isSymbolicLink())return 'link:'+stat.ino+':'+stat.mode+':'+volume.readlinkSync(path)
      // Compare content as well as metadata, same-sized writes can share a timestamp.
      return 'file:'+stat.ino+':'+stat.mode+':'+volume.readFileSync(path).toString('base64')
    }catch(error){if((error as {code?:string}).code==='ENOENT')return undefined;throw error}
  }
  function seed(path:string){
    const state=signature(path)
    if(state===undefined)return
    states.set(path,state)
    if(volume.lstatSync(path).isDirectory())for(const name of volume.readdirSync(path))seed(path+'/'+String(name))
  }
  seed(root)
  const pending=new Set<string>()
  let scheduled=false
  let closed=false
  const watcher=volume.watch(root,{recursive:true},(_event,filename)=>{
    if(closed||!filename)return
    const path=root+'/'+String(filename)
    if(path.split('/').includes('..'))return
    pending.add(path)
    if(scheduled)return
    scheduled=true
    queueMicrotask(()=>{
      scheduled=false
      const batch=[...pending]
      const queued=new Set(batch)
      const enqueue=(path:string)=>{if(!queued.has(path)){queued.add(path);batch.push(path)}}
      pending.clear()
      if(closed)return
      for(const path of batch){
        if(closed)break
        const previous=states.get(path),next=signature(path)
        if(previous===next)continue
        const replaced=previous!==undefined&&next!==undefined&&
          previous.split(':',2).join(':')!==next.split(':',2).join(':')
        // A directory rename can notify only its roots. Reconcile descendants
        // too, so the next edit is compared with the moved file's actual state.
        if((next===undefined||replaced)&&previous?.startsWith('directory:')){
          for(const known of states.keys())if(known.startsWith(path+'/'))enqueue(known)
        }
        if((previous===undefined||replaced)&&next?.startsWith('directory:')){
          for(const name of volume.readdirSync(path))enqueue(path+'/'+String(name))
        }
        if(next===undefined)states.delete(path)
        else states.set(path,next)
        emit(previous===undefined||next===undefined||replaced?'rename':'change',path)
      }
    })
  })
  const close=watcher.close.bind(watcher)
  watcher.close=()=>{
    closed=true
    pending.clear()
    states.clear()
    return close()
  }
  return watcher
}
