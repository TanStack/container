import type {WorkspaceSnapshot} from './files'
import {openSandboxDatabase} from './database'

const chunkBytes=1024*1024

export interface CheckpointMetadata {
  key:string
  formatVersion:1
  snapshotVersion:WorkspaceSnapshot['version']
  createdAt:number
  updatedAt:number
  files:number
  directories:number
  symlinks:number
  bytes:number
  chunks:number
}

interface StoredFile {bytes:number;chunks:string[]}
interface StoredCheckpoint extends CheckpointMetadata {
  entries:Record<string,StoredFile>
  directoryEntries:string[]
  symlinkEntries:Record<string,string>
  fileModes?:Record<string,number>
  directoryModes?:Record<string,number>
}

function checkpointKey(key:string){
  if(typeof key!=='string'||!key)throw Error('A checkpoint key is required')
  return key
}

function request<T>(value:IDBRequest<T>):Promise<T>{
  return new Promise((resolve,reject)=>{
    value.onsuccess=()=>resolve(value.result)
    value.onerror=()=>reject(value.error??Error('Checkpoint database request failed'))
  })
}

function transactionDone(transaction:IDBTransaction):Promise<void>{
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=()=>resolve()
    transaction.onabort=()=>reject(transaction.error??Error('Checkpoint transaction aborted'))
    transaction.onerror=()=>{/* The abort event provides the final transaction error. */}
  })
}

function bytes(value:unknown):Uint8Array{
  if(value instanceof Uint8Array)return value
  if(value instanceof ArrayBuffer)return new Uint8Array(value)
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength)
  throw Error('Invalid checkpoint blob')
}

async function digest(value:Uint8Array){
  if(!globalThis.crypto?.subtle)throw Error('Checkpoint persistence requires Web Crypto')
  const input=new Uint8Array(value.byteLength);input.set(value)
  const hash=await crypto.subtle.digest('SHA-256',input)
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('')
}

function publicMetadata(manifest:StoredCheckpoint):CheckpointMetadata{
  const {key,formatVersion,snapshotVersion,createdAt,updatedAt,files,directories,symlinks,bytes,chunks}=manifest
  return {key,formatVersion,snapshotVersion,createdAt,updatedAt,files,directories,symlinks,bytes,chunks}
}

async function collectSnapshot(key:string,snapshot:WorkspaceSnapshot){
  const entries:Record<string,StoredFile>={},blobs=new Map<string,Uint8Array>()
  let totalBytes=0
  for(const [path,value] of Object.entries(snapshot.files)){
    const hashes:string[]=[]
    totalBytes+=value.byteLength
    for(let offset=0;offset<value.byteLength;offset+=chunkBytes){
      const chunk=value.slice(offset,Math.min(value.byteLength,offset+chunkBytes))
      const hash=await digest(chunk)
      hashes.push(hash)
      if(!blobs.has(hash))blobs.set(hash,chunk)
    }
    entries[path]={bytes:value.byteLength,chunks:hashes}
  }
  const directoryEntries=snapshot.version===1?[]:[...snapshot.directories]
  const symlinkEntries='symlinks' in snapshot?{...snapshot.symlinks}:{}
  return {key,entries,blobs,totalBytes,directoryEntries,symlinkEntries}
}

async function removeUnreferenced(transaction:IDBTransaction){
  const manifests=transaction.objectStore('checkpoint-manifests')
  const blobs=transaction.objectStore('checkpoint-blobs')
  const values=await request(manifests.getAll()) as StoredCheckpoint[]
  const retained=new Set(values.flatMap(manifest=>Object.values(manifest.entries).flatMap(file=>file.chunks)))
  const keys=await request(blobs.getAllKeys())
  for(const key of keys)if(typeof key==='string'&&!retained.has(key))blobs.delete(key)
}

export async function saveKernelCheckpoint(key:string,snapshot:WorkspaceSnapshot):Promise<CheckpointMetadata>{
  checkpointKey(key)
  const prepared=await collectSnapshot(key,snapshot)
  const db=await openSandboxDatabase()
  try{
    const transaction=db.transaction(['checkpoint-manifests','checkpoint-blobs'],'readwrite')
    const manifests=transaction.objectStore('checkpoint-manifests')
    const blobs=transaction.objectStore('checkpoint-blobs')
    const done=transactionDone(transaction)
    const previous=await request(manifests.get(key)) as StoredCheckpoint|undefined
    const now=Date.now()
    const manifest:StoredCheckpoint={
      key,formatVersion:1,snapshotVersion:snapshot.version,
      createdAt:previous?.createdAt??now,updatedAt:now,
      files:Object.keys(prepared.entries).length,
      directories:prepared.directoryEntries.length,
      symlinks:Object.keys(prepared.symlinkEntries).length,
      bytes:prepared.totalBytes,chunks:new Set(Object.values(prepared.entries).flatMap(file=>file.chunks)).size,
      entries:prepared.entries,directoryEntries:prepared.directoryEntries,symlinkEntries:prepared.symlinkEntries,
      ...('fileModes' in snapshot?{fileModes:{...snapshot.fileModes}}:{}),
      ...('directoryModes' in snapshot?{directoryModes:{...snapshot.directoryModes}}:{}),
    }
    for(const [hash,value] of prepared.blobs)blobs.put(value,hash)
    manifests.put(manifest,key)
    await removeUnreferenced(transaction)
    await done
    return publicMetadata(manifest)
  }finally{db.close()}
}

export async function restoreKernelCheckpoint(key:string):Promise<{snapshot:WorkspaceSnapshot;metadata:CheckpointMetadata}>{
  checkpointKey(key)
  const db=await openSandboxDatabase()
  try{
    const transaction=db.transaction(['checkpoint-manifests','checkpoint-blobs'],'readonly')
    const manifests=transaction.objectStore('checkpoint-manifests')
    const blobStore=transaction.objectStore('checkpoint-blobs')
    const done=transactionDone(transaction)
    const manifest=await request(manifests.get(key)) as StoredCheckpoint|undefined
    if(!manifest){transaction.abort();await done.catch(()=>{});throw Error(`No checkpoint: ${key}`)}
    if(manifest.formatVersion!==1)throw Error(`Unsupported checkpoint format: ${manifest.formatVersion}`)
    const hashes=[...new Set(Object.values(manifest.entries).flatMap(file=>file.chunks))]
    const stored=await Promise.all(hashes.map(async hash=>[hash,bytes(await request(blobStore.get(hash)))] as const))
    await done
    const blobs=new Map(stored)
    const files:Record<string,Uint8Array>={}
    for(const [path,file] of Object.entries(manifest.entries)){
      const value=new Uint8Array(file.bytes)
      let offset=0
      for(const hash of file.chunks){
        const chunk=blobs.get(hash)
        if(!chunk)throw Error(`Checkpoint blob is missing: ${hash}`)
        value.set(chunk,offset);offset+=chunk.byteLength
      }
      if(offset!==file.bytes)throw Error(`Checkpoint file is corrupt: ${path}`)
      files[path]=value
    }
    const common={files,directories:[...manifest.directoryEntries]}
    const snapshot:WorkspaceSnapshot=manifest.snapshotVersion===1?{version:1,files}
      :manifest.snapshotVersion===2?{version:2,...common}
      :manifest.snapshotVersion===3?{version:3,...common,symlinks:{...manifest.symlinkEntries}}
      :manifest.snapshotVersion===4?{version:4,...common,symlinks:{...manifest.symlinkEntries},fileModes:{...manifest.fileModes!}}
      :manifest.snapshotVersion===5?{version:5,...common,symlinks:{...manifest.symlinkEntries},fileModes:{...manifest.fileModes!},directoryModes:{...manifest.directoryModes!}}
      :(()=>{throw Error(`Unsupported snapshot version: ${manifest.snapshotVersion}`)})()
    return {snapshot,metadata:publicMetadata(manifest)}
  }finally{db.close()}
}

export async function deleteKernelCheckpoint(key:string):Promise<boolean>{
  checkpointKey(key)
  const db=await openSandboxDatabase()
  try{
    const transaction=db.transaction(['checkpoint-manifests','checkpoint-blobs'],'readwrite')
    const store=transaction.objectStore('checkpoint-manifests')
    const done=transactionDone(transaction)
    const existed=Boolean(await request(store.getKey(key)))
    store.delete(key)
    await removeUnreferenced(transaction)
    await done
    return existed
  }finally{db.close()}
}

export async function kernelCheckpointMetadata(key:string):Promise<CheckpointMetadata|undefined>{
  checkpointKey(key)
  const db=await openSandboxDatabase()
  try{
    const transaction=db.transaction('checkpoint-manifests','readonly')
    const done=transactionDone(transaction)
    const manifest=await request(transaction.objectStore('checkpoint-manifests').get(key)) as StoredCheckpoint|undefined
    await done
    return manifest?publicMetadata(manifest):undefined
  }finally{db.close()}
}
