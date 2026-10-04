import {VirtualNetwork} from '../sandbox/virtual-network'

// Network ownership does not require installing browser process globals.
export const network=new VirtualNetwork()
export function virtualListeningPorts(){return network.listeningPorts}
export function connectVirtual(port:number){
  const {id,port:localPort,remotePort}=network.connect(2,port)
  return Promise.resolve({
    port:localPort,remotePort,
    write:(bytes:Uint8Array)=>network.write(2,id,bytes),
    read:()=>network.next(2,id),
    end:async()=>{network.end(2,id)},
    close:async()=>{try{network.destroy(2,id)}catch(error){if((error as {code?:string}).code!=='EBADF')throw error}},
  })
}
