import assert from 'node:assert/strict'
import {Volume} from 'memfs'
import {observeWorkspaceEvents} from '../src/native/workspace-events.ts'

const volume=Volume.fromJSON({'/app/existing.txt':'old'})
const events=[]
const watcher=observeWorkspaceEvents(volume,'/app',(event,path)=>events.push({event,path}))
try{
  volume.writeFileSync('/app/new.txt','one')
  await Promise.resolve()
  assert.deepEqual(events.splice(0),[{event:'rename',path:'/app/new.txt'}])
  volume.writeFileSync('/app/new.txt','two')
  await Promise.resolve()
  assert.deepEqual(events.splice(0),[{event:'change',path:'/app/new.txt'}])
  volume.writeFileSync('/app/existing.txt','new')
  await Promise.resolve()
  assert.deepEqual(events.splice(0),[{event:'change',path:'/app/existing.txt'}])
  volume.unlinkSync('/app/new.txt')
  await Promise.resolve()
  assert.deepEqual(events.splice(0),[{event:'rename',path:'/app/new.txt'}])
  volume.renameSync('/app/existing.txt','/app/renamed.txt')
  await Promise.resolve()
  assert.deepEqual(events.splice(0).sort((a,b)=>a.path.localeCompare(b.path)),[
    {event:'rename',path:'/app/existing.txt'},{event:'rename',path:'/app/renamed.txt'},
  ])
  volume.writeFileSync('/app/renamed.txt','pending')
  watcher.close()
  await Promise.resolve()
  assert.deepEqual(events,[],'Closing must cancel pending delivery')
  console.log('Workspace creation, same-sized edit, existing edit, deletion, rename, and pending-close matched')
}finally{watcher.close()}

const reentrant=Volume.fromJSON({'/app/first.txt':'a','/app/second.txt':'a'})
const delivered=[]
const reentrantWatcher=observeWorkspaceEvents(reentrant,'/app',(event,path)=>{
  delivered.push({event,path})
  if(path==='/app/first.txt')reentrant.writeFileSync('/app/second.txt','b')
})
try{
  reentrant.writeFileSync('/app/first.txt','b')
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(delivered,[{event:'change',path:'/app/first.txt'},{event:'change',path:'/app/second.txt'}])
  console.log('Reentrant workspace edits matched')
}finally{reentrantWatcher.close()}

const nested=Volume.fromJSON({'/app/tree/nested/file.txt':'old'})
const nestedEvents=[]
const nestedWatcher=observeWorkspaceEvents(nested,'/app',(event,path)=>nestedEvents.push({event,path}))
try{
  nested.renameSync('/app/tree','/app/moved')
  await Promise.resolve()
  assert.ok(nestedEvents.some(item=>item.event==='rename'&&item.path==='/app/tree'))
  assert.ok(nestedEvents.some(item=>item.event==='rename'&&item.path==='/app/moved'))
  nestedEvents.length=0
  nested.writeFileSync('/app/moved/nested/file.txt','new')
  await Promise.resolve()
  assert.deepEqual(nestedEvents,[{event:'change',path:'/app/moved/nested/file.txt'}])
  nestedEvents.length=0
  nested.rmSync('/app/moved',{recursive:true})
  await Promise.resolve()
  assert.ok(nestedEvents.some(item=>item.event==='rename'&&item.path==='/app/moved/nested/file.txt'))
  nestedEvents.length=0
  nested.mkdirSync('/app/moved/nested',{recursive:true})
  nested.writeFileSync('/app/moved/nested/file.txt','new')
  await Promise.resolve()
  assert.ok(nestedEvents.some(item=>item.event==='rename'&&item.path==='/app/moved/nested/file.txt'))
  nestedEvents.length=0
  nested.writeFileSync('/app/moved/nested/file.txt','next')
  await Promise.resolve()
  assert.deepEqual(nestedEvents,[{event:'change',path:'/app/moved/nested/file.txt'}])
  console.log('Directory rename followed by a nested edit matched')
  console.log('Directory deletion and same-content recreation matched')
}finally{nestedWatcher.close()}

const atomic=Volume.fromJSON({'/app/value.txt':'same'})
const atomicEvents=[]
const atomicWatcher=observeWorkspaceEvents(atomic,'/app',(event,path)=>atomicEvents.push({event,path}))
try{
  atomic.writeFileSync('/app/replacement.txt','same')
  atomic.renameSync('/app/replacement.txt','/app/value.txt')
  await Promise.resolve()
  assert.deepEqual(atomicEvents,[{event:'rename',path:'/app/value.txt'}],
    'Replacing a file must be observable even when its bytes match')
  console.log('Same-content atomic file replacement matched')
}finally{atomicWatcher.close()}
