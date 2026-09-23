import {expect,test} from 'vitest'
import {readFileSync} from 'node:fs'
import cluster from 'node:cluster'
import dgram from 'node:dgram'

const report=(name:string)=>JSON.parse(readFileSync(`compat/node-${name}-feasibility.json`,'utf8'))

test('cluster lifecycle and local listener sharing map to guest processes',()=>{
  const value=report('cluster'),processes=readFileSync('src/sandbox/guest-processes.ts','utf8'),ipc=readFileSync('src/sandbox/process-message-queue.ts','utf8')
  expect({isPrimary:cluster.isPrimary,isWorker:cluster.isWorker,worker:cluster.worker}).toEqual({isPrimary:true,isWorker:false,worker:undefined})
  expect(value).toMatchObject({schemaVersion:1,feature:'node:cluster',status:'implemented-sandbox-local',implemented:true,browserOnly:true,sharedListeners:true})
  expect(value.processMapping.backend).toMatch(/GuestProcesses.*IPC/)
  expect(value.processMapping.mustNotUse).toBe('node:worker_threads')
  expect(value.processMapping.implementedAPIs).toContain('fork')
  expect(value.unsupported).toContain('OS process and external socket claims')
  expect(processes).toContain('class GuestProcesses');expect(processes).toContain("ipcMode?:'json'|'advanced'");expect(ipc).toContain('class ProcessMessageQueue')
})

test('dgram decision requires atomic packets instead of reusing virtual streams',()=>{
  const value=report('dgram'),network=readFileSync('src/sandbox/virtual-network.ts','utf8'),builtins=readFileSync('src/compiler/builtins.ts','utf8')
  const socket=dgram.createSocket('udp4')
  try{
    expect(()=>socket.address()).toThrow(expect.objectContaining({code:'EBADF'}))
    expect(typeof socket.bind).toBe('function');expect(typeof socket.send).toBe('function');expect(typeof socket.addMembership).toBe('function')
  }finally{expect(socket.close()).toBe(socket)}
  expect(value).toMatchObject({schemaVersion:1,feature:'node:dgram',status:'implemented-sandbox-local',implemented:true,browserOnly:true})
  expect(value.truthfulLocalSurface).toContain('atomic send delivery without stream connection state')
  expect(value.mustReject).toContain('external hosts and operating-system UDP')
  expect(network).toContain("type:'connection'");expect(network).toContain("type:'end'");expect(network).not.toContain("type:'message'")
  expect(builtins).toContain("'node:dgram':")
})
