import {expect,it} from 'vitest'
import {connect,createServer,createSecureContext,TLSSocket} from '../src/vite-browser/node-tls'

it('rejects TLS operations explicitly rather than opening plaintext sockets',()=>{
  for(const operation of [connect,createServer,createSecureContext,()=>new TLSSocket()]){
    let error:unknown
    try{operation()}catch(value){error=value}
    expect(error).toMatchObject({code:'ERR_UNSUPPORTED_OPERATION'})
  }
})
