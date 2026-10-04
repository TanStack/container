import {createNativeFilesystemBackend} from './filesystem-backend.mjs'
import {createWasiFilesystemService} from './wasi-filesystem-service.mjs'
import {createFilesystemServiceControl} from './filesystem-service-control.mjs'
import {createOnMessage as create124} from 'tanstack:filesystem-codec-124'
import {createOnMessage as create114} from 'tanstack:filesystem-codec-114'

const {fs}=createNativeFilesystemBackend()
const service=createWasiFilesystemService(fs,{'1.2.4':create124,'1.1.4':create114})
const control=createFilesystemServiceControl(service)
self.addEventListener('message',event=>{
  if(event.data?.type==='native-filesystem-inspect')
    self.postMessage({type:'native-filesystem-inspect',...service.inspect(),...service.inspectWatchers(),...control.inspect()})
  else control.onMessage(event)
})
self.postMessage({type:'native-filesystem-ready'})
