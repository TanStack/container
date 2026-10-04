import {expect,it,vi} from 'vitest'
import {MessageChannel} from 'node:worker_threads'
import {Volume} from 'memfs'
import {createNativeSyncFileLane,NativeSyncFileClient,NativeSyncFileHost} from '../src/native/sync-file-bridge'

const headerBytes=Int32Array.BYTES_PER_ELEMENT*4
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0))

it('waits for a reply predicate when a delayed prior notification wakes the next request',()=>{
  const lane=createNativeSyncFileLane(),header=new Int32Array(lane,0,4)
  const body=new Uint8Array(lane,headerBytes)
  const client=new NativeSyncFileClient({postMessage(){},close(){}} as MessagePort,lane)
  const wait=vi.spyOn(Atomics,'wait')
    .mockImplementationOnce(()=> 'ok')
    .mockImplementationOnce(()=>{
      const bytes=new TextEncoder().encode(JSON.stringify({value:'current reply'}))
      body.set(bytes);Atomics.store(header,1,bytes.length);Atomics.store(header,2,2);Atomics.store(header,0,1)
      return 'ok'
    })
  try{
    expect(client.call('stat',['/project'])).toBe('current reply')
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait.mock.calls[1]![3]).toBeLessThanOrEqual(wait.mock.calls[0]![3]!)
  }finally{wait.mockRestore();client.close()}
})

it('repeated notifications do not extend the original file request deadline',()=>{
  const lane=createNativeSyncFileLane()
  const close=vi.fn()
  const client=new NativeSyncFileClient({postMessage(){},close} as unknown as MessagePort,lane)
  const clock=vi.spyOn(performance,'now')
    .mockReturnValueOnce(0).mockReturnValueOnce(0)
    .mockReturnValueOnce(10000).mockReturnValueOnce(20000).mockReturnValueOnce(30000)
  const wait=vi.spyOn(Atomics,'wait').mockReturnValue('ok')
  try{
    expect(()=>client.call('stat',['/project'])).toThrow('timed out')
    expect(wait.mock.calls.map(call=>call[3])).toEqual([30000,20000,10000])
    expect(close).toHaveBeenCalledOnce()
  }finally{wait.mockRestore();clock.mockRestore();client.close()}
})

it('serves live workspace reads and writes through the shared reply lane',async()=>{
  const volume=Volume.fromJSON({'/app/answer.txt':'before'})
  const lane=createNativeSyncFileLane()
  const {port1,port2}=new MessageChannel()
  const host=new NativeSyncFileHost(volume,port1 as unknown as MessagePort,lane)
  const header=new Int32Array(lane,0,4)
  const body=new Uint8Array(lane,headerBytes)
  const request=async(method:string,args:unknown[])=>{
    Atomics.store(header,0,0)
    port2.postMessage({method,args})
    for(let i=0;i<50&&Atomics.load(header,0)===0;i++)await tick()
    expect(Atomics.load(header,0)).not.toBe(0)
    const bytes=body.slice(0,Atomics.load(header,1))
    return Atomics.load(header,2)===1?bytes:JSON.parse(new TextDecoder().decode(bytes))
  }
  const fd=(await request('open',['/project/answer.txt',2,0])).value as number
  expect(new TextDecoder().decode(await request('read',[fd,6]) as Uint8Array)).toBe('before')
  await request('close',[fd])
  volume.writeFileSync('/app/answer.txt','updated')
  const nextFd=(await request('open',['/project/answer.txt',0,0])).value as number
  expect(new TextDecoder().decode(await request('read',[nextFd,7]) as Uint8Array)).toBe('updated')
  await request('close',[nextFd])
  await request('writeFile',['/project/answer.txt',new TextEncoder().encode('changed')])
  expect(volume.readFileSync('/app/answer.txt','utf8')).toBe('changed')
  volume.writeFileSync('/app/answer.txt','from preview')
  expect(new TextDecoder().decode(await request('readFile',['/project/answer.txt']) as Uint8Array)).toBe('from preview')
  expect((await request('realpath',['/project/answer.txt'])).value).toBe('/app/answer.txt')
  await request('mkdir',['/project/nested',false])
  await request('rename',['/project/answer.txt','/project/nested/answer.txt'])
  expect(volume.readFileSync('/app/nested/answer.txt','utf8')).toBe('from preview')
  await request('unlink',['/project/nested/answer.txt'])
  expect(volume.existsSync('/app/nested/answer.txt')).toBe(false)
  volume.writeFileSync('/app/nested/copied.txt','copied live')
  await request('cp',['/project/nested','/project/copied',{recursive:true}])
  expect(volume.readFileSync('/app/copied/copied.txt','utf8')).toBe('copied live')
  expect([...host.files.changedPaths]).toEqual(['/app/answer.txt','/app/nested','/app/nested/answer.txt','/app/copied'])
  const error=await request('open',['/outside.txt',0,0])
  expect(error).toEqual({message:'Error: Cannot leave the container filesystem',code:'ERR_OUTSIDE_CONTAINER_PATH'})
  const realpathError=await request('realpath',['/outside.txt'])
  expect(realpathError).toEqual({message:'Error: Cannot leave the container filesystem',code:'ERR_OUTSIDE_CONTAINER_PATH'})
  expect(volume.statSync('/tmp').isDirectory()).toBe(true)
  await request('writeFile',['/tmp/scratch.txt',new TextEncoder().encode('scratch')])
  expect(new TextDecoder().decode(await request('readFile',['/tmp/scratch.txt']) as Uint8Array)).toBe('scratch')
  host.close()
  port2.close()
})

it('decodes replies and rejects calls after close',()=>{
  const lane=createNativeSyncFileLane()
  const header=new Int32Array(lane,0,4)
  const body=new Uint8Array(lane,headerBytes)
  let closed=false
  const port={postMessage(){
    const bytes=new TextEncoder().encode(JSON.stringify({value:['one','two']}))
    body.set(bytes)
    Atomics.store(header,1,bytes.length)
    Atomics.store(header,2,2)
    Atomics.store(header,0,1)
  },close(){closed=true}} as unknown as MessagePort
  const client=new NativeSyncFileClient(port,lane)
  expect(client.call('readdir',['/project'])).toEqual(['one','two'])
  client.close()
  expect(closed).toBe(true)
  expect(()=>client.call('stat',['/project'])).toThrow('closed')
})

it('forwards nested worker file calls to the live parent bridge',async()=>{
  const local=Volume.fromJSON({'/app/value.txt':'stale'})
  const calls:Array<{method:string;args:unknown[]}>=[]
  const upstream={call(method:string,args:unknown[]){
    calls.push({method,args})
    if(method==='readFile')return new TextEncoder().encode('live')
    return undefined
  }} as NativeSyncFileClient
  const lane=createNativeSyncFileLane()
  const {port1,port2}=new MessageChannel()
  const host=new NativeSyncFileHost(local,port1 as unknown as MessagePort,lane,upstream)
  const header=new Int32Array(lane,0,4),body=new Uint8Array(lane,headerBytes)
  port2.postMessage({method:'readFile',args:['/app/value.txt']})
  for(let i=0;i<50&&Atomics.load(header,0)===0;i++)await tick()
  expect(Atomics.load(header,0)).toBe(1)
  expect(new TextDecoder().decode(body.slice(0,Atomics.load(header,1)))).toBe('live')
  expect(calls).toEqual([{method:'readFile',args:['/app/value.txt']}])
  host.close();port2.close()
})
