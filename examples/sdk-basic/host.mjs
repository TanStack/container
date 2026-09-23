export function examplePorts(defaults,options={}){
  const ports={}
  for(const name of ['ownerPort','previewPort']){
    const value=options[name]??defaults[name]
    if((typeof value!=='number'&&typeof value!=='string')||!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)>65535)throw new Error(`${name} must be an integer from 0 to 65535`)
    ports[name]=Number(value)
  }
  if(ports.ownerPort!==0&&ports.ownerPort===ports.previewPort)throw new Error('Owner and preview ports must be different')
  return ports
}

export function listen(server,port){
  return new Promise((resolve,reject)=>{
    const failed=error=>{server.off('listening',ready);reject(error)}
    const ready=()=>{server.off('error',failed);resolve(`http://127.0.0.1:${server.address().port}`)}
    server.once('error',failed)
    server.once('listening',ready)
    server.listen(port,'127.0.0.1')
  })
}

export function closeServer(server){
  return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
}
