import {FILESYSTEM_ATTACH,FILESYSTEM_DETACH} from './filesystem-worker-link.mjs'

export function createFilesystemServiceControl(service){
  const ports=new Map()
  function detach(id){
    for(const [name,state]of ports){
      if(name!==id&&!name.startsWith(id+'/'))continue
      ports.delete(name);state.port.removeEventListener('message',state.listener);state.port.close()
    }
    service.releaseScope(id)
  }
  function onMessage(event){
    const {data}=event
    if(data?.type===FILESYSTEM_ATTACH){
      if(typeof data.id!=='string'||!data.id||ports.has(data.id)||!data.port?.addEventListener)
        throw Error('Invalid filesystem control connection')
      const listener=message=>onMessage(message)
      ports.set(data.id,{port:data.port,listener})
      data.port.addEventListener('message',listener);data.port.start()
    }else if(data?.type===FILESYSTEM_DETACH)detach(data.id)
    else service.onMessage(event)
  }
  return {onMessage,inspect:()=>({controls:ports.size}),dispose(){
    for(const id of [...ports.keys()])detach(id)
    service.dispose()
  }}
}
