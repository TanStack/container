import dgram from 'node:dgram'
const socket=dgram.createSocket('udp4'),events=[]
try{socket.address()}catch(error){events.push(error.code)}
socket.unref().ref()
socket.on('close',()=>events.push('close'))
socket.close(()=>events.push('callback'))
events.push('sync')
setImmediate(()=>console.log(JSON.stringify(events)))
