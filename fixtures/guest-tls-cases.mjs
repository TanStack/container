export const guestTLSCases={
  'HTTPS GET and chunked POST use authenticated TLS':`
    import https from 'node:https';
    const server=https.createServer({cert,key},(req,res)=>{let body='';req.on('data',bytes=>body+=bytes);req.on('end',()=>{res.setHeader('x-encrypted',String(req.socket.encrypted));res.write(req.method+':');res.end(body||req.url)})});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const results=[];
    for(const method of ['GET','POST'])results.push(await new Promise((resolve,reject)=>{
      const req=https.request({host:'127.0.0.1',port:server.address().port,path:'/secure',servername:'localhost',ca,method,agent:false},res=>{let body='';res.on('data',bytes=>body+=bytes);res.on('end',()=>resolve([res.statusCode,res.headers['x-encrypted'],res.socket.authorized,body]));res.on('error',reject)});
      req.on('error',reject);if(method==='POST'){req.write('first');req.write('second')}req.end();
    }));await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(results));`,
  'HTTPS URL requests inherit agent trust and reject untrusted peers':`
    import https from 'node:https';const server=https.createServer({cert,key},(req,res)=>res.end('secure'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const agent=new https.Agent({ca,servername:'localhost'}),results=[];
    const url='https://127.0.0.1:'+server.address().port+'/';
    results.push(await new Promise((resolve,reject)=>{https.get(url,{agent},res=>{let text='';res.on('data',bytes=>text+=bytes);res.on('end',()=>resolve(text));res.on('error',reject)}).on('error',reject)}));
    results.push(await new Promise(resolve=>{https.get(url,{servername:'localhost',agent:false},res=>{res.resume();resolve(false)}).on('error',()=>resolve(true))}));
    agent.destroy();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(results));`,
  'CA parsing retains only certificates before a malformed PEM block':`
    import tls from 'node:tls';import {Buffer} from 'node:buffer';
    const broken='-----BEGIN CERTIFICATE-----\\nbroken\\n-----END CERTIFICATE-----\\n';
    const server=tls.createServer({cert,key},socket=>{socket.on('error',()=>{});socket.end()});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const results=[];
    for(const input of ['not a certificate',broken,'ignored text\\n'+ca,ca+broken,broken+ca,Buffer.from(ca)]){
      results.push(await new Promise(resolve=>{
        const socket=tls.connect({host:'127.0.0.1',port:server.address().port,servername:'localhost',ca:input});
        socket.once('secureConnect',()=>{resolve(socket.authorized);socket.destroy()});socket.once('error',()=>resolve(false));
      }));
    }
    await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(results));`,
  'secure context validates provided material synchronously':`
    import tls from 'node:tls';
    const results=[];
    for(const settings of [{},{cert},{key},{cert,key},{ca}]){try{tls.createSecureContext(settings);results.push(true)}catch{results.push(false)}}
    for(const settings of [{ca:'not a certificate'},{cert,key:wrongKey}]){try{tls.createSecureContext(settings);results.push(false)}catch{results.push(true)}}
    console.log(JSON.stringify(results));`,
  'TLS 1.2 authenticated echo':`
    import tls from 'node:tls';
    const server=tls.createServer({cert,key,minVersion:'TLSv1.2',maxVersion:'TLSv1.2'},socket=>{socket.on('error',()=>{});socket.on('data',bytes=>socket.write(bytes));socket.on('end',()=>socket.end())});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const result=await new Promise((resolve,reject)=>{
      const socket=tls.connect({host:'127.0.0.1',port:server.address().port,servername:'localhost',ca,minVersion:'TLSv1.2',maxVersion:'TLSv1.2'},()=>socket.write('hello TLS'));
      let response='';socket.on('data',bytes=>{response+=bytes.toString();socket.end()});socket.on('error',reject);
      socket.on('end',()=>resolve([response,socket.authorized,socket.getProtocol(),socket.encrypted]));
    });await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(result));`,
  'TLS 1.3 authenticated echo':`
    import tls from 'node:tls';
    const server=tls.createServer({cert,key,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},socket=>{socket.on('error',()=>{});socket.on('data',bytes=>socket.write(bytes));socket.on('end',()=>socket.end())});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const result=await new Promise((resolve,reject)=>{
      const socket=tls.connect({host:'127.0.0.1',port:server.address().port,servername:'localhost',ca,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},()=>socket.write('hello TLS'));
      let response='';socket.on('data',bytes=>{response+=bytes.toString();socket.end()});socket.on('error',reject);
      socket.on('end',()=>resolve([response,socket.authorized,socket.getProtocol(),socket.encrypted]));
    });await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(result));`,
  'untrusted certificates and wrong hostnames reject before secureConnect':`
    import tls from 'node:tls';const server=tls.createServer({cert,key},socket=>socket.end());
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const results=[];
    for(const settings of [{servername:'wrong.invalid',ca},{servername:'localhost'}])results.push(await new Promise(resolve=>{
      const socket=tls.connect({host:'127.0.0.1',port:server.address().port,...settings});
      socket.once('error',()=>resolve(true));socket.once('secureConnect',()=>{socket.end();resolve(false)});
    }));await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(results));`,
  'large encrypted stream with a paused consumer':`
    import tls from 'node:tls';import {Buffer} from 'node:buffer';
    const server=tls.createServer({cert,key},socket=>{socket.on('error',()=>{});socket.pipe(socket)});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const result=await new Promise((resolve,reject)=>{
      let count=0,sum=0;const socket=tls.connect({host:'127.0.0.1',port:server.address().port,servername:'localhost',ca},()=>socket.end(Buffer.alloc(256*1024,7)));
      socket.on('data',bytes=>{count+=bytes.length;for(const byte of bytes)sum+=byte;socket.pause();setTimeout(()=>socket.resume(),1)});
      socket.on('error',reject);socket.on('end',()=>resolve([count,sum]));
    });await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(result));`,
  'TLS callbacks preserve async local storage':`
    import tls from 'node:tls';import {AsyncLocalStorage} from 'node:async_hooks';const als=new AsyncLocalStorage(),seen=[];let server;
    await als.run('server',()=>new Promise(resolve=>{server=tls.createServer({cert,key},socket=>{seen.push(als.getStore());socket.on('error',()=>{});socket.on('data',async bytes=>{await Promise.resolve();socket.end(bytes.toString()+':'+als.getStore())})});server.listen(0,'127.0.0.1',resolve)}));
    await als.run('client',()=>new Promise((resolve,reject)=>{const socket=tls.connect({host:'127.0.0.1',port:server.address().port,servername:'localhost',ca},()=>{seen.push(als.getStore());socket.write('hello')});socket.on('data',bytes=>seen.push(bytes.toString(),als.getStore()));socket.on('end',resolve);socket.on('error',reject)}));
    await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(seen));`,
}
