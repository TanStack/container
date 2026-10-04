import { joinPath } from '../fs/path'
import type { VirtualFileSystem } from '../fs/types'
import { extractTarFiles } from './tar'
import {startInstallPhase,traceInstallPhase,traceAsyncInstallPhase} from './install-phase-trace'
import type { InstallProgress, LockedPackage, RuntimeLock } from './types'
import {deletePackageRecord,loadPackageRecords,packageCacheTimestamp,readPackageRecord,writePackageRecord} from './package-cache-storage'
import {cancellableWait} from './cancellable-wait'

interface CacheLimits {archiveBytes:number;archiveEntries:number;metadataBytes:number;metadataEntries:number}
// Bound archive bytes independently from entry metadata, so normal dependency
// graphs do not evict small packages while most of the byte budget is unused.
const defaultCacheLimits:CacheLimits={archiveBytes:32*1024*1024,archiveEntries:1024,metadataBytes:16*1024*1024,metadataEntries:128}
interface CacheEntry<T>{value:T;bytes:number;used:number}
export class PackageInstallCache {
  readonly #limits:CacheLimits
  readonly #archives=new Map<string,CacheEntry<Uint8Array>>()
  readonly #metadata=new Map<string,CacheEntry<string>>()
  readonly #pendingArchives=new Map<string,{promise:Promise<Uint8Array>;controller:AbortController;users:number}>()
  readonly #writes=new Set<Promise<void>>()
  readonly #ready:Promise<void>
  #clock=0
  constructor(limits:Partial<CacheLimits>={}){
    this.#limits={...defaultCacheLimits,...limits}
    this.#ready=this.#hydrateMetadata().catch(()=>{})
  }
  async #hydrateMetadata(){
    const records=await loadPackageRecords('metadata')
    records.sort((a,b)=>a.used-b.used||a.key.localeCompare(b.key))
    for(const record of records){
      if(record.kind==='metadata')this.#put(this.#metadata,record.key,record.value,record.bytes,this.#limits.metadataBytes,this.#limits.metadataEntries)
    }
  }
  ready(signal?:AbortSignal){return cancellableWait(this.#ready,signal)}
  async flush(signal?:AbortSignal){
    signal?.throwIfAborted()
    while(this.#writes.size)await cancellableWait(Promise.allSettled([...this.#writes]),signal)
    signal?.throwIfAborted()
  }
  #persist(operation:Promise<void>){this.#writes.add(operation);void operation.finally(()=>this.#writes.delete(operation)).catch(()=>{})}
  #get<T>(entries:Map<string,CacheEntry<T>>,key:string){const entry=entries.get(key);if(entry)entry.used=++this.#clock;return entry?.value}
  #put<T>(entries:Map<string,CacheEntry<T>>,key:string,value:T,bytes:number,maxBytes:number,maxEntries:number){
    if(bytes>maxBytes||maxEntries<1)return
    entries.delete(key);entries.set(key,{value,bytes,used:++this.#clock})
    const size=()=>[...entries.values()].reduce((sum,entry)=>sum+entry.bytes,0)
    while(entries.size>maxEntries||size()>maxBytes){
      const oldest=[...entries].sort((a,b)=>a[1].used-b[1].used||a[0].localeCompare(b[0]))[0]
      if(!oldest)break
      entries.delete(oldest[0])
    }
  }
  getMetadata(name:string){
    const value=this.#get(this.#metadata,name)
    if(value!==undefined){const bytes=new TextEncoder().encode(value).length;this.#persist(writePackageRecord({id:'metadata:'+name,version:1,kind:'metadata',key:name,value,bytes,used:packageCacheTimestamp()},this.#limits.metadataBytes,this.#limits.metadataEntries).catch(()=>{}))}
    return value
  }
  deleteMetadata(name:string){this.#metadata.delete(name);void deletePackageRecord('metadata',name).catch(()=>{})}
  putMetadata(name:string,text:string,bytes:number){
    this.#put(this.#metadata,name,text,bytes,this.#limits.metadataBytes,this.#limits.metadataEntries)
    this.#persist(writePackageRecord({id:'metadata:'+name,version:1,kind:'metadata',key:name,value:text,bytes,used:packageCacheTimestamp()},this.#limits.metadataBytes,this.#limits.metadataEntries).catch(()=>{}))
  }
  async archive(integrity:string,load:(signal?:AbortSignal)=>Promise<Uint8Array>,signal?:AbortSignal){
    signal?.throwIfAborted()
    const hit=this.#get(this.#archives,integrity)
    if(hit){
      if(integrity.startsWith('sha512-'))void writePackageRecord({id:'archive:'+integrity,version:1,kind:'archive',key:integrity,value:Uint8Array.from(hit).buffer,bytes:hit.length,used:packageCacheTimestamp()},this.#limits.archiveBytes,this.#limits.archiveEntries).catch(()=>{})
      return hit
    }
    let pending=this.#pendingArchives.get(integrity)
    if(!pending){
    const controller=new AbortController()
    const operation=(async()=>{
      const stored=await traceAsyncInstallPhase('archive-cache-read',()=>readPackageRecord('archive',integrity,controller.signal)).catch(error=>{controller.signal.throwIfAborted();return undefined})
      controller.signal.throwIfAborted()
      if(stored?.kind==='archive'){
        const value=new Uint8Array(stored.value)
        try{await verifyIntegrity(value,integrity);controller.signal.throwIfAborted();this.#put(this.#archives,integrity,value,value.length,this.#limits.archiveBytes,this.#limits.archiveEntries);return value}
        catch{
          controller.signal.throwIfAborted()
          await deletePackageRecord('archive',integrity,controller.signal).catch(()=>{controller.signal.throwIfAborted()})
        }
      }
      const value=await traceAsyncInstallPhase('archive-download',()=>load(controller.signal))
      controller.signal.throwIfAborted()
      this.#put(this.#archives,integrity,value,value.length,this.#limits.archiveBytes,this.#limits.archiveEntries)
      if(integrity.startsWith('sha512-'))await traceAsyncInstallPhase('archive-cache-write',()=>writePackageRecord({id:'archive:'+integrity,version:1,kind:'archive',key:integrity,value:Uint8Array.from(value).buffer,bytes:value.length,used:packageCacheTimestamp()},this.#limits.archiveBytes,this.#limits.archiveEntries,controller.signal)).catch(()=>{controller.signal.throwIfAborted()})
      return value
    })()
    pending={promise:operation,controller,users:0}
    this.#pendingArchives.set(integrity,pending)
    const entry=pending
    void operation.finally(()=>{if(this.#pendingArchives.get(integrity)===entry)this.#pendingArchives.delete(integrity)}).catch(()=>{})
    }
    const entry=pending
    entry.users++
    return new Promise<Uint8Array>((resolve,reject)=>{
      let settled=false
      const finish=(failed:boolean,error:unknown,value?:Uint8Array)=>{
        if(settled)return
        settled=true
        signal?.removeEventListener('abort',abort)
        entry.users--
        if(failed)reject(error);else resolve(value!)
      }
      const abort=()=>{
        finish(true,signal!.reason)
        if(entry.users===0){
          if(this.#pendingArchives.get(integrity)===entry)this.#pendingArchives.delete(integrity)
          entry.controller.abort(signal!.reason)
        }
      }
      signal?.addEventListener('abort',abort,{once:true})
      entry.promise.then(value=>finish(false,undefined,value),error=>finish(true,error))
    })
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

async function verifyIntegrity(archive: Uint8Array, integrity: string): Promise<void> {
  const [algorithm, encodedDigest] = integrity.split('-', 2)
  if (algorithm !== 'sha512' || !encodedDigest) {
    throw new Error(`Unsupported package integrity '${integrity}'`)
  }
  const archiveBuffer = Uint8Array.from(archive).buffer
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', archiveBuffer))
    : Uint8Array.from(
        (await import('sha.js')).default('sha512')
          .update(new Uint8Array(archiveBuffer))
          .digest(),
      )
  if (!equalBytes(digest, decodeBase64(encodedDigest))) {
    throw new Error('Package archive failed its SHA-512 integrity check')
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal,onActivity?:()=>void): Promise<Uint8Array> {
  const reader = stream.getReader()
  // Cancel closes pending reads immediately, even if the source's cleanup promise
  // remains pending. No further chunks or workspace writes may follow an abort.
  const cancel = (reason: unknown) => { void reader.cancel(reason).catch(() => {}) }
  const abort = () => cancel(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (signal?.aborted) { abort(); signal.throwIfAborted() }
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.length
      if (size > maxBytes) {
        const error = new Error('Package exceeds download or extraction limit')
        cancel(error)
        throw error
      }
      chunks.push(value)
      onActivity?.()
    }
  } catch (error) {
    signal?.throwIfAborted()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}

async function decompressGzip(archive: Uint8Array, signal?: AbortSignal,onActivity?:()=>void): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const body = new Response(Uint8Array.from(archive).buffer).body
  if (!body) throw new Error('Could not read package archive')
  const decompressed = body.pipeThrough(new DecompressionStream('gzip'))
  return readBounded(decompressed, 64 * 1024 * 1024, signal,onActivity)
}

async function loadVerifiedArchive(resolved:string,integrity:string,signal?:AbortSignal,cache?:PackageInstallCache,onActivity?:()=>void){
  const url=new URL(resolved)
  if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.port||url.username||url.password||url.hash)
    throw Error('Package downloads are restricted to https://registry.npmjs.org')
  const load=async(sharedSignal=signal)=>{
    let response:Response
    try{response=await fetch(resolved,{signal:sharedSignal,credentials:'omit',redirect:'error'})}
    catch(error){
      sharedSignal?.throwIfAborted()
      throw new Error(`Could not download ${url.pathname}: ${String(error)}`,{cause:error})
    }
    if(!response.ok){
      const error=Error(`Could not download ${url.pathname} (${response.status})`)
      // Failed bodies still own transport resources. Start cleanup without
      // allowing its acknowledgement to replace or delay the HTTP failure.
      void response.body?.cancel(error).catch(()=>{})
      throw error
    }
    if(!response.body)throw Error('Package download has no body')
    let archive:Uint8Array
    try{archive=await readBounded(response.body,16*1024*1024,sharedSignal,onActivity)}
    catch(error){
      sharedSignal?.throwIfAborted()
      throw new Error(`Could not read archive ${url.pathname}: ${String(error)}`,{cause:error})
    }
    await verifyIntegrity(archive,integrity)
    onActivity?.()
    return archive
  }
  return cache?cache.archive(integrity,load,signal):load()
}

/** Inspect package manifests already included in a registry tarball. */
export async function inspectBundledPackages(resolved:string,integrity:string,cache?:PackageInstallCache,signal?:AbortSignal,onActivity?:()=>void){
  const archive=await loadVerifiedArchive(resolved,integrity,signal,cache,onActivity)
  const files=extractTarFiles(await traceAsyncInstallPhase('gzip-decompression',()=>decompressGzip(archive,signal,onActivity)))
  const bundled:{path:string;manifest:Record<string,unknown>}[]=[]
  for(const file of files){
    if(!file.path.startsWith('node_modules/')||!file.path.endsWith('/package.json'))continue
    const path=file.path.slice(0,-'/package.json'.length)
    const manifest=JSON.parse(new TextDecoder().decode(file.contents)) as unknown
    if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw Error('Invalid bundled package manifest: '+path)
    bundled.push({path,manifest:manifest as Record<string,unknown>})
    if(bundled.length>128)throw Error('Package archive contains too many bundled packages')
  }
  return bundled.sort((a,b)=>a.path.localeCompare(b.path))
}

async function installPackage(
  fs: VirtualFileSystem,
  lockedPackage: LockedPackage,
  signal?: AbortSignal,
  cache?:PackageInstallCache,
  onActivity?:()=>void,
): Promise<void> {
  const archive=await loadVerifiedArchive(lockedPackage.resolved,lockedPackage.integrity,signal,cache,onActivity)
  onActivity?.()
  signal?.throwIfAborted()
  const tar = await traceAsyncInstallPhase('gzip-decompression',()=>decompressGzip(archive, signal,onActivity))
  const files=traceInstallPhase('tar-extraction',()=>extractTarFiles(tar))
  const finishWrites=startInstallPhase('package-file-write')
  try {
  for (const file of files) {
    signal?.throwIfAborted()
    const destination=joinPath(lockedPackage.installPath,file.path)
    const owner=[lockedPackage,...lockedPackage.bundledPackages??[]]
      .filter(pkg=>destination.startsWith(pkg.installPath+'/'))
      .sort((a,b)=>b.installPath.length-a.installPath.length)[0]
    const ownerRelativePath=owner?destination.slice(owner.installPath.length+1):''
    if(!owner||ownerRelativePath.startsWith('node_modules/'))throw Error('Archive contains an undeclared bundled package: '+file.path)
    await fs.writeFile(destination, file.contents,{followSymlinks:false,mode:file.mode})
    onActivity?.()
  }
  finishWrites('end')
  } catch(error) {
    finishWrites('error')
    throw error
  }
}

async function linkPackageExecutables(fs:VirtualFileSystem,lock:RuntimeLock){
  if(!fs.symlink)return
  for(const pkg of lock.packages.flatMap(item=>[item,...item.bundledPackages??[]])){
    const marker=pkg.installPath.lastIndexOf('/node_modules/')
    if(marker<0)continue
    const manifest=JSON.parse(await fs.readText(joinPath(pkg.installPath,'package.json'))) as
      {name?:unknown;bin?:unknown}
    if(!manifest.bin)continue
    const bins=typeof manifest.bin==='string'
      ?{[String(manifest.name??pkg.name??'').split('/').pop()!]:manifest.bin}
      :manifest.bin
    if(!bins||typeof bins!=='object'||Array.isArray(bins))
      throw Error('Invalid package executable declaration: '+pkg.installPath)
    for(const [name,target] of Object.entries(bins)){
      if(!/^[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*$/.test(name)||typeof target!=='string'||!target||
        target.startsWith('/')||target.includes('\\')||target.split('/').includes('..'))
        throw Error('Invalid package executable: '+name)
      const source=joinPath(pkg.installPath,target)
      if(!(await (fs.isFile?.(source)??fs.exists(source))))
        throw Error('Package executable is missing: '+source)
      await fs.chmod?.(source,0o755)
      const executable=joinPath(pkg.installPath.slice(0,marker), 'node_modules/.bin',name)
      if(!(await fs.exists(executable)))await fs.symlink(source,executable)
    }
  }
}

export async function installLockedPackages(
  fs: VirtualFileSystem,
  lock: RuntimeLock,
  onProgress?: (progress: InstallProgress) => void,
  signal?: AbortSignal,
  cache?:PackageInstallCache,
  onActivity?:()=>void,
): Promise<void> {
  if (lock.version !== 1) throw new Error(`Unsupported runtime lock version '${lock.version}'`)
  const controller=new AbortController()
  const abort=()=>controller.abort(signal?.reason)
  if(signal?.aborted)abort()
  else signal?.addEventListener('abort',abort,{once:true})
  let nextIndex = 0
  let completed = 0
  const worker = async () => {
    while (nextIndex < lock.packages.length) {
      controller.signal.throwIfAborted()
      const lockedPackage = lock.packages[nextIndex++]
      try{await installPackage(fs, lockedPackage, controller.signal,cache,onActivity)}catch(error){controller.abort(error);throw error}
      completed++
      onProgress?.({ completed, total: lock.packages.length, package: lockedPackage })
    }
  }
  const concurrency = Math.min(4, lock.packages.length)
  // Wait for every download/write to settle before the caller discards its stage.
  try{
    const outcomes=await Promise.allSettled(Array.from({ length: concurrency }, () => worker()))
    const failure=outcomes.find((result):result is PromiseRejectedResult=>result.status==='rejected')
    if(failure)throw controller.signal.reason??failure.reason
    await linkPackageExecutables(fs,lock)
  }finally{signal?.removeEventListener('abort',abort)}
}
