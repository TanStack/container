import {createNativeFilesystemClientApi} from '../../src/native/filesystem-client-api.mjs'
import type {NativeFileOperations} from '../../src/native/filesystem-operations'
import {VolumeFileSystem} from '../../src/native/volume-file-system'
import {NativeTerminalFileSession} from '../../src/native/terminal-file-session'

export async function checkClientTypes(client:ReturnType<typeof createNativeFilesystemClientApi>){
  const files:NativeFileOperations=client.vol
  new VolumeFileSystem(files)
  const terminal=new NativeTerminalFileSession(files)
  terminal.close()
  const stream=client.fs.createReadStream('/app/file',{start:0})
  stream.destroy()
  const writer=client.fs.createWriteStream('/app/output',{flush:true})
  writer.end('bytes')
  const handle=await client.fs.promises.open('/app/file','r')
  await handle.read(Buffer.alloc(2),0,2,null)
  await handle.close()
  const directory=client.fs.opendirSync('/app')
  directory.readSync()?.isDirectory()
  directory.closeSync()
  client.fs.opendir('/app',(error,value)=>{if(!error)value.closeSync()})
  for await(const entry of await client.fs.promises.opendir('/app'))entry.isFile()
  for await(const entry of client.fs.promises.glob('*')){
    if(typeof entry!=='string')entry.isDirectory()
  }
  const watcher=client.fs.watch('/app')
  watcher.unref().close()
}
