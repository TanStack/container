import process from 'node:process'
process.on('message',message=>{
  if(message.kind==='request'){
    process.send({kind:'reply',value:message.value+1,bytes:[...message.bytes],bigint:String(message.bigint),connected:process.connected})
  }else if(message.kind==='finish'){
    process.disconnect()
  }
})
process.send({kind:'ready'})
