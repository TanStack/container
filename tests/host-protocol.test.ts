import {describe,expect,it} from 'vitest'
import {HOST_ATTACH_TYPE,HOST_OPERATIONS,HOST_PROTOCOL_VERSION,parseHostAttachMessage,parseHostClientMessage,parseHostServerMessage} from '../src/sdk/host-protocol'

describe('host protocol validation',()=>{
  it('accepts the exact attachment schema',()=>{
    const message={type:HOST_ATTACH_TYPE,protocolVersion:HOST_PROTOCOL_VERSION,nonce:'abc',ownerOrigin:'https://owner.test'}
    expect(parseHostAttachMessage(message)).toBe(message)
    expect(()=>parseHostAttachMessage({...message,extra:true})).toThrow('Invalid browser sandbox host attachment')
    expect(()=>parseHostAttachMessage({...message,ownerOrigin:1})).toThrow()
  })
  it('accepts only known operations and exact request fields',()=>{
    expect(parseHostClientMessage({type:'request',id:1,operation:'kernel.readFile',args:['/a']})).toMatchObject({id:1})
    expect(parseHostClientMessage({type:'cancel',requestId:2})).toEqual({type:'cancel',requestId:2})
    expect(()=>parseHostClientMessage({type:'request',id:1,operation:'kernel.eval',args:[]})).toThrow()
    expect(()=>parseHostClientMessage({type:'request',id:1,operation:HOST_OPERATIONS[0],args:[],extra:true})).toThrow()
  })
  it('validates attachment capabilities, result, error, output, ports and closure',()=>{
    const messages=[
      {type:'attached',protocolVersion:1,nonce:'abc',capabilities:{protocolVersion:1,buildId:'build',apiVersion:5,crossOriginIsolated:true,sharedArrayBuffer:true,indexedDB:true,operations:HOST_OPERATIONS}},
      {type:'result',id:1,value:new Uint8Array([1])},
      {type:'error',id:2,error:{name:'Error',message:'bad',code:'EFAIL'}},
      {type:'output',requestId:3,level:'log',text:'hello'},
      {type:'port',event:{type:'open',port:4173}},
      {type:'closed',reason:{name:'Error',message:'bye'}},
    ]
    for(const message of messages)expect(parseHostServerMessage(message)).toBe(message)
    expect(()=>parseHostServerMessage({type:'port',event:{type:'open',port:70000}})).toThrow()
    expect(()=>parseHostServerMessage({type:'error',id:1,error:{message:'missing name'}})).toThrow()
  })
})
