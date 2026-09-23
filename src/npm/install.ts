import { joinPath } from '../fs/path'
import type { VirtualFileSystem } from '../fs/types'
import { extractTarFiles } from './tar'
import {startInstallPhase,traceInstallPhase} from './install-phase-trace'
import type { InstallProgress, LockedPackage, RuntimeLock } from './types'
import {deletePackageRecord,loadPackageRecords,packageCacheTimestamp,readPackageRecord,writePackageRecord} from './package-cache-storage'

interface CacheLimits {archiveBytes:number;archiveEntries:number;metadataBytes:number;metadataEntries:number}
const defaultCacheLimits:CacheLimits={archiveBytes:32*1024*1024,archiveEntries:128,metadataBytes:16*1024*1024,metadataEntries:128}
interface CacheEntry<T>{value:T;bytes:number;used:number}
export class PackageInstallCache {
  readonly #limits:CacheLimits
  readonly #archives=new Map<string,CacheEntry<Uint8Array>>()
  readonly #metadata=new Map<string,CacheEntry<string>>()
  readonly #pendingArchives=new Map<string,Promise<Uint8Array>>()
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
  ready(){return this.#ready}
  async flush(){while(this.#writes.size)await Promise.allSettled([...this.#writes])}
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
  async archive(integrity:string,load:()=>Promise<Uint8Array>){
    const hit=this.#get(this.#archives,integrity)
    if(hit){
      if(integrity.startsWith('sha512-'))void writePackageRecord({id:'archive:'+integrity,version:1,kind:'archive',key:integrity,value:Uint8Array.from(hit).buffer,bytes:hit.length,used:packageCacheTimestamp()},this.#limits.archiveBytes,this.#limits.archiveEntries).catch(()=>{})
      return hit
    }
    const pending=this.#pendingArchives.get(integrity)
    if(pending)return pending
    const operation=(async()=>{
      const stored=await readPackageRecord('archive',integrity).catch(()=>undefined)
      if(stored?.kind==='archive'){
        const value=new Uint8Array(stored.value)
        try{await verifyIntegrity(value,integrity);this.#put(this.#archives,integrity,value,value.length,this.#limits.archiveBytes,this.#limits.archiveEntries);return value}
        catch{await deletePackageRecord('archive',integrity).catch(()=>{})}
      }
      const value=await load()
      this.#put(this.#archives,integrity,value,value.length,this.#limits.archiveBytes,this.#limits.archiveEntries)
      if(integrity.startsWith('sha512-'))await writePackageRecord({id:'archive:'+integrity,version:1,kind:'archive',key:integrity,value:Uint8Array.from(value).buffer,bytes:value.length,used:packageCacheTimestamp()},this.#limits.archiveBytes,this.#limits.archiveEntries).catch(()=>{})
      return value
    })()
    this.#pendingArchives.set(integrity,operation)
    try{return await operation}finally{this.#pendingArchives.delete(integrity)}
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

async function installPackage(
  fs: VirtualFileSystem,
  lockedPackage: LockedPackage,
  signal?: AbortSignal,
  cache?:PackageInstallCache,
  onActivity?:()=>void,
): Promise<void> {
  const load=async()=>{
    const response = await fetch(lockedPackage.resolved, { signal, credentials: 'omit', redirect: 'error' })
    if (!response.ok) throw new Error(`Could not download ${lockedPackage.installPath} (${response.status})`)
    if (!response.body) throw new Error('Package download has no body')
    const archive = await readBounded(response.body, 16 * 1024 * 1024, signal,onActivity)
    await verifyIntegrity(archive, lockedPackage.integrity)
    onActivity?.()
    return archive
  }
  const archive=cache?await cache.archive(lockedPackage.integrity,load):await load()
  onActivity?.()
  signal?.throwIfAborted()
  const tar = await decompressGzip(archive, signal,onActivity)
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
  }finally{signal?.removeEventListener('abort',abort)}
}
