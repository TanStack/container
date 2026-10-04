import {nativeFileOperationNames} from '../../src/native/filesystem-operations'
import type {NativeFileOperations} from '../../src/native/filesystem-operations'
import {VolumeFileSystem} from '../../src/native/volume-file-system'
import {NativeTerminalFileSession} from '../../src/native/terminal-file-session'
import {NativeTerminalProcesses} from '../../src/native/terminal-processes'
import {installLiveLockedPackages} from '../../src/native/live-package-install'
import {planProjectInstall} from '../../src/npm/project'

export {nativeFileOperationNames}
export async function runFilesystemConsumerControl(volume:NativeFileOperations,observer:NativeFileOperations,
  project:{files:Record<string,string>;archives:Record<string,number[]>}){
  const checks:string[]=[]
  const check=(condition:unknown,label:string)=>{if(!condition)throw Error(label);checks.push(label)}
  const bytes=Uint8Array.from({length:200000},(_,index)=>index%251)
  const view=new VolumeFileSystem(volume)
  await view.writeFile('/app/binary.bin',bytes,{mode:0o640,followSymlinks:false})
  await view.symlink('/app/binary.bin','/app/bin-link')
  const seen=observer.readFileSync('/app/binary.bin') as Uint8Array
  check(seen.length===bytes.length&&seen.every((value,index)=>value===bytes[index]),'binary bytes shared')
  check(observer.statSync('/app/binary.bin').mode%0o1000===0o640,'file mode shared')
  check(String(observer.realpathSync('/app/bin-link'))==='/app/binary.bin','executable link shared')
  check(JSON.stringify(await view.list('/app'))===JSON.stringify(['/app/binary.bin']),'list excludes symlink')
  const files=new NativeTerminalFileSession(volume)
  const fd=files.call('open',['/app/binary.bin',0,0]) as number
  try{
    check(JSON.stringify([...files.call('read',[fd,2,2]) as Uint8Array])==='[2,3]','positioned terminal read')
    check(JSON.stringify([...files.call('read',[fd,2]) as Uint8Array])==='[0,1]','implicit terminal cursor')
    const processes=new NativeTerminalProcesses(volume,files)
    try{
      const pid=processes.call('process.spawn',[['cat','binary.bin'],'/app',{}]) as number
      let offset=0,chunks=0
      for(;;){
        const event=await processes.call('process.next',[pid]) as {type:string;bytes?:Uint8Array;code?:number}|null
        if(!event)throw Error('Terminal exited without status')
        if(event.type==='exit'){check(event.code===0,'terminal cat exit');break}
        if(event.type!=='stdout'||!event.bytes?.every((value,index)=>value===bytes[offset+index]))throw Error('Terminal bytes differ')
        offset+=event.bytes.length;chunks++
      }
      check(offset===bytes.length&&chunks>1,'terminal cat streams complete bytes')
    }finally{processes.close()}
  }finally{files.close()}
  const mount=()=>{
    volume.rmSync('/app/node_modules',{recursive:true,force:true})
    for(const [path,text] of Object.entries(project.files)){
      const target='/app'+path
      volume.mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true})
      volume.writeFileSync(target,text)
    }
  }
  mount()
  const manifest=String(volume.readFileSync('/app/package.json')),lockText=String(volume.readFileSync('/app/package-lock.json'))
  const planned=planProjectInstall(manifest,lockText)
  const lock={version:1 as const,packages:planned.lock.packages.map(pkg=>({...pkg,installPath:'/app'+pkg.installPath}))}
  const original=globalThis.fetch
  let onFetch:(()=>void)|undefined
  globalThis.fetch=async input=>{
    onFetch?.()
    const archive=project.archives[String(input)]
    if(!archive)throw Error('Only the owned package fixture may be fetched')
    return new Response(Uint8Array.from(archive))
  }
  try{
    const installed=await installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText})
    check(installed.installed===3&&!observer.existsSync('/app/node_modules/stale'),'verified install shared')
    check(String(observer.realpathSync('/app/node_modules/.bin/parent'))==='/app/node_modules/parent/index.js','installed executable shared')
    mount();volume.writeFileSync('/app/npm-shrinkwrap.json',lockText)
    let failed=false
    try{await installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText,lockText:lockText+'\n',
      afterCommit:async()=>{throw Error('refresh failed')}})}catch(error){failed=String(error).includes('refresh failed')}
    check(failed&&String(observer.readFileSync('/app/node_modules/stale/index.js'))==='stale','failed refresh restores packages')
    check(String(observer.readFileSync('/app/npm-shrinkwrap.json'))===lockText,'failed refresh restores shrinkwrap')
    volume.unlinkSync('/app/npm-shrinkwrap.json');mount()
    onFetch=()=>observer.writeFileSync('/app/package.json',manifest+'\n')
    failed=false
    try{await installLiveLockedPackages(volume,lock,{expectedManifest:manifest,expectedLock:lockText})}
    catch(error){failed=String(error).includes('changed during')}
    check(failed&&String(observer.readFileSync('/app/node_modules/stale/index.js'))==='stale','other-client manifest edit cancels commit')
    check(volume.readdirSync('/app').every(name=>!String(name).startsWith('.native-install-')),'staging paths cleaned')
  }finally{globalThis.fetch=original}
  return {checks,bytes:bytes.length,passed:true}
}
