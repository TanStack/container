setTimeout(()=>{
  process.once('message',value=>{process.send({received:value})})
  process.send({listening:true})
},100)
