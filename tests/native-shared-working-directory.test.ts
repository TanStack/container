import {test,expect} from 'vitest'
import {SharedWorkingDirectory} from '../src/native/shared-working-directory'
import {Worker} from 'node:worker_threads'
import {buildSync} from 'esbuild'
test('shared readers observe later changes and Unicode paths',()=>{
  const owner=new SharedWorkingDirectory(),reader=new SharedWorkingDirectory(owner.buffer)
  for(const directory of ['/app','/tmp/你好','/tmp','/app/deep/path']){
    owner.write(directory)
    expect(reader.read()).toBe(directory)
  }
})
test('oversized update does not replace the current directory',()=>{
  const owner=new SharedWorkingDirectory();owner.write('/app')
  expect(()=>owner.write('/'+ 'a'.repeat(4096))).toThrow(expect.objectContaining({code:'ENAMETOOLONG'}))
  expect(owner.read()).toBe('/app')
})
test('interrupted unpublished writes leave readers on the complete directory',()=>{
  const owner=new SharedWorkingDirectory();owner.write('/app')
  const reader=new SharedWorkingDirectory(owner.buffer)
  const header=new Int32Array(owner.buffer,0,3),inactive=(Atomics.load(header,0)+1)&1
  new Uint8Array(owner.buffer,12+inactive*4096,4096).fill(255)
  Atomics.store(header,inactive+1,4095)
  expect(reader.read()).toBe('/app')
  owner.write('/tmp/recovered')
  expect(reader.read()).toBe('/tmp/recovered')
})
test('concurrent worker reads see whole published paths',async()=>{
  const bundled=buildSync({entryPoints:['src/native/shared-working-directory.ts'],bundle:true,format:'esm',platform:'node',write:false}).outputFiles[0]!.text
  const url='data:text/javascript;base64,'+Buffer.from(bundled).toString('base64')
  const owner=new SharedWorkingDirectory(),paths=['/app/'+ 'a'.repeat(2000),'/tmp/'+ '好'.repeat(600)]
  owner.write(paths[0]!)
  const worker=new Worker(`import {parentPort,workerData} from 'node:worker_threads';
    const {SharedWorkingDirectory}=await import(${JSON.stringify(url)});
    const reader=new SharedWorkingDirectory(workerData.buffer);
    parentPort.postMessage('ready');
    for(let index=0;index<10000;index++)if(!workerData.paths.includes(reader.read()))throw Error('Torn cwd read');
    parentPort.postMessage('done');`,{eval:true,workerData:{buffer:owner.buffer,paths}})
  try{
    await new Promise<void>((resolve,reject)=>{
      worker.on('error',reject)
      worker.on('message',message=>{
        if(message==='ready')for(let index=0;index<10000;index++)owner.write(paths[index%2]!)
        if(message==='done')resolve()
      })
      worker.on('exit',code=>{if(code!==0)reject(Error('Reader worker failed'))})
    })
  }finally{await worker.terminate()}
},10000)
