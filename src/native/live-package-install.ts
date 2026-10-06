import {Volume} from 'memfs'
import type {NativeFileOperations} from './filesystem-operations'
import {installLockedPackages,PackageInstallCache} from '../npm/install'
import type {InstallProgress,RuntimeLock} from '../npm/types'
import type {PackageDownloadPolicy} from '../npm/download-policy'
import {VolumeFileSystem} from './volume-file-system'

function copyTree(source:NativeFileOperations,from:string,target:NativeFileOperations,to:string){
  const stat=source.lstatSync(from)
  if(stat.isDirectory()){
    target.mkdirSync(to,{recursive:true,mode:stat.mode&0o777})
    for(const name of source.readdirSync(from).map(String))copyTree(source,from+'/'+name,target,to+'/'+name)
    target.chmodSync(to,stat.mode&0o777)
  }else if(stat.isSymbolicLink())target.symlinkSync(String(source.readlinkSync(from)),to)
  else if(stat.isFile()){
    target.writeFileSync(to,source.readFileSync(from))
    target.chmodSync(to,stat.mode&0o777)
  }else throw Error('Unsupported installed package entry')
}

/** Stage a locked install, then synchronously swap its package tree into the live volume. */
export async function installLiveLockedPackages(volume:NativeFileOperations,lock:RuntimeLock,options:{
  signal?:AbortSignal
  cache?:PackageInstallCache
  packageDownloadPolicy?:PackageDownloadPolicy
  onProgress?:(progress:InstallProgress)=>void
  lockText?:string
  lockPath?:'/app/package-lock.json'|'/app/npm-shrinkwrap.json'
  expectedManifest:string
  expectedLock?:string
  /** Refresh the running project before the prior package tree is discarded. */
  afterCommit?:()=>Promise<void>
}){
  if(!volume.existsSync('/app/package.json'))throw Error('Project package.json is missing')
  const selectedLockPath=()=>volume.existsSync('/app/npm-shrinkwrap.json')?'/app/npm-shrinkwrap.json':'/app/package-lock.json'
  const lockPath=options.lockPath??selectedLockPath()
  if(!['/app/package-lock.json','/app/npm-shrinkwrap.json'].includes(lockPath))throw Error('Invalid project lockfile path')
  if(selectedLockPath()!==lockPath)throw Error('Project lockfile changed during dependency installation')
  for(const pkg of lock.packages){
    if(!pkg.installPath.startsWith('/app/node_modules/')||pkg.installPath.includes('/../'))
      throw Error('Live install package path is outside node_modules')
  }
  const staged=new Volume()
  staged.mkdirSync('/app/node_modules',{recursive:true})
  await installLockedPackages(new VolumeFileSystem(staged),lock,options.onProgress,options.signal,options.cache,undefined,options.packageDownloadPolicy)
  options.signal?.throwIfAborted()
  const id=crypto.randomUUID().replaceAll('-','')
  const stagePath='/app/.native-install-stage-'+id
  const backupPath='/app/.native-install-backup-'+id
  if(volume.existsSync(stagePath)||volume.existsSync(backupPath))throw Error('Native install staging path already exists')
  let committed=false,oldMoved=false,newMoved=false
  let priorLock:Uint8Array|undefined
  try{
    volume.mkdirSync(stagePath)
    copyTree(staged,'/app/node_modules',volume,stagePath+'/node_modules')
    options.signal?.throwIfAborted()
    if(String(volume.readFileSync('/app/package.json'))!==options.expectedManifest)
      throw Error('Project package.json changed during dependency installation')
    if(selectedLockPath()!==lockPath)throw Error('Project lockfile changed during dependency installation')
    const currentLock=volume.existsSync(lockPath)?String(volume.readFileSync(lockPath)):undefined
    if(currentLock!==options.expectedLock)throw Error('Project lockfile changed during dependency installation')
    if(currentLock!==undefined)priorLock=new Uint8Array(volume.readFileSync(lockPath) as Uint8Array)
    try{
      if(volume.existsSync('/app/node_modules')){volume.renameSync('/app/node_modules',backupPath);oldMoved=true}
      volume.renameSync(stagePath+'/node_modules','/app/node_modules');newMoved=true
      if(options.lockText!==undefined)volume.writeFileSync(lockPath,options.lockText)
      await options.afterCommit?.()
      committed=true
    }catch(error){
      const rollbackErrors:unknown[]=[]
      try{if(newMoved)volume.rmSync('/app/node_modules',{recursive:true,force:true})}catch(rollback){rollbackErrors.push(rollback)}
      try{if(oldMoved)volume.renameSync(backupPath,'/app/node_modules')}catch(rollback){rollbackErrors.push(rollback)}
      try{
        if(priorLock)volume.writeFileSync(lockPath,priorLock)
        else if(options.lockText!==undefined&&volume.existsSync(lockPath))volume.unlinkSync(lockPath)
      }catch(rollback){rollbackErrors.push(rollback)}
      if(rollbackErrors.length)throw new AggregateError([error,...rollbackErrors],'Live dependency install and rollback failed')
      throw error
    }
  }finally{
    if(volume.existsSync(stagePath))volume.rmSync(stagePath,{recursive:true,force:true})
  }
  if(committed&&oldMoved)volume.rmSync(backupPath,{recursive:true,force:true})
  return {installed:lock.packages.length,changedPaths:['/app/node_modules',...(options.lockText===undefined?[]:[lockPath])]}
}
