import {expect,it} from 'vitest'

it('loads shared networking without installing browser globals',async()=>{
  const before={process:globalThis.process,Buffer:globalThis.Buffer,
    host:Object.getOwnPropertyDescriptor(globalThis,'__webContainerHost'),
    wasm:Object.getOwnPropertyDescriptor(globalThis,'__rollupWasmBytes')}
  await import('../src/vite-browser/runtime-network')
  expect(globalThis.process).toBe(before.process)
  expect(globalThis.Buffer).toBe(before.Buffer)
  expect(Object.getOwnPropertyDescriptor(globalThis,'__webContainerHost')).toEqual(before.host)
  expect(Object.getOwnPropertyDescriptor(globalThis,'__rollupWasmBytes')).toEqual(before.wasm)
})

it('shares listener ownership, transfers bytes both ways, and releases closed sockets',async()=>{
  const {network,connectVirtual,virtualListeningPorts}=await import('../src/vite-browser/runtime-network')
  const owner=91
  const listener=network.listen(owner,0)
  const socket=await connectVirtual(listener.port)
  const connection=await network.next(owner,listener.id)
  if(connection?.type!=='connection')throw Error('Expected accepted connection')
  try{
    expect(virtualListeningPorts()).toContain(listener.port)
    await socket.write(new Uint8Array([1,2,3]))
    expect(await network.next(owner,connection.id)).toEqual({type:'data',bytes:new Uint8Array([1,2,3])})
    await network.write(owner,connection.id,new Uint8Array([4,5]))
    expect(await socket.read()).toEqual({type:'data',bytes:new Uint8Array([4,5])})
    await socket.end()
    expect(await network.next(owner,connection.id)).toEqual({type:'end'})
    await socket.close()
    await socket.close()
  }finally{
    await socket.close()
    network.destroy(owner,connection.id)
    network.closeServer(owner,listener.id)
  }
  expect(virtualListeningPorts()).not.toContain(listener.port)
  expect(await network.next(owner,listener.id)).toEqual({type:'close'})
})
