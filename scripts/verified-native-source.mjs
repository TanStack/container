import {createHash} from 'node:crypto'
import {lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs'
import {isAbsolute,join,relative,resolve,sep} from 'node:path'

const HEX_SHA256=/^[0-9a-f]{64}$/
const posix=path=>path.split(sep).join('/')
export const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex')

function requireRelativePath(value,label){
  if(typeof value!=='string'||!value||isAbsolute(value)||value.split(/[\\/]/).includes('..'))throw Error(`${label} must be a safe relative path`)
}

function requireHash(value,label){
  if(typeof value!=='string'||!HEX_SHA256.test(value))throw Error(`${label} must be a lowercase SHA-256 hash`)
}

function filesWithExtension(directory,extension,recursive){
  const directoryEntry=lstatSync(directory)
  if(directoryEntry.isSymbolicLink()||!directoryEntry.isDirectory())throw Error(`Native source input directory must be a real directory: ${directory}`)
  const out=[]
  for(const name of readdirSync(directory).sort()){
    const path=join(directory,name),entry=lstatSync(path)
    if(entry.isSymbolicLink())throw Error(`Native source input must not be a symbolic link: ${path}`)
    if(entry.isDirectory()){
      if(recursive)out.push(...filesWithExtension(path,extension,true))
    }else if(entry.isFile()&&name.endsWith(extension))out.push(path)
  }
  return out
}

export function readNativeSourceDescriptor(descriptorPath){
  const descriptor=JSON.parse(readFileSync(descriptorPath,'utf8'))
  if(descriptor.format!==1)throw Error(`Unsupported native source descriptor format in ${descriptorPath}`)
  if(typeof descriptor.id!=='string'||!descriptor.id)throw Error(`Missing native source id in ${descriptorPath}`)
  if(typeof descriptor.version!=='string'||!descriptor.version)throw Error(`Missing native source version in ${descriptorPath}`)
  if(typeof descriptor.archive?.url!=='string'||!descriptor.archive.url.startsWith('https://'))throw Error(`Native source archive URL must use HTTPS in ${descriptorPath}`)
  requireHash(descriptor.archive?.sha256,'archive.sha256')
  requireRelativePath(descriptor.license?.path,'license.path')
  requireHash(descriptor.license?.sha256,'license.sha256')
  requireRelativePath(descriptor.inputs?.sourceDirectory,'inputs.sourceDirectory')
  requireRelativePath(descriptor.inputs?.headerDirectory,'inputs.headerDirectory')
  for(const field of ['sourceExtension','headerExtension'])if(typeof descriptor.inputs?.[field]!=='string'||!descriptor.inputs[field].startsWith('.'))throw Error(`${field} must be a file extension`)
  if(!Number.isSafeInteger(descriptor.inputs?.fileCount)||descriptor.inputs.fileCount<1)throw Error('inputs.fileCount must be a positive integer')
  requireHash(descriptor.inputs?.sha256,'inputs.sha256')
  return descriptor
}

export function verifyNativeSourceRoot(descriptorPath,sourceRoot){
  if(typeof sourceRoot!=='string'||!sourceRoot)throw Error('An explicit native source root is required')
  const requestedRoot=resolve(sourceRoot),rootEntry=lstatSync(requestedRoot)
  if(rootEntry.isSymbolicLink()||!rootEntry.isDirectory())throw Error(`Native source root must be a real directory: ${requestedRoot}`)
  const root=realpathSync(requestedRoot),descriptor=readNativeSourceDescriptor(descriptorPath)
  const sourceDirectory=join(root,descriptor.inputs.sourceDirectory)
  const headerDirectory=join(root,descriptor.inputs.headerDirectory)
  const sources=filesWithExtension(sourceDirectory,descriptor.inputs.sourceExtension,false)
  const headers=filesWithExtension(headerDirectory,descriptor.inputs.headerExtension,true)
  const license=join(root,descriptor.license.path)
  const licenseEntry=lstatSync(license)
  if(licenseEntry.isSymbolicLink()||!licenseEntry.isFile())throw Error(`Native source license must be a real file: ${license}`)
  const entries=[...new Set([...sources,...headers,license])].map(path=>{
    const name=posix(relative(root,path))
    if(name.startsWith('../')||name==='..')throw Error(`Native source input escaped its root: ${path}`)
    return [name,hashFile(path)]
  }).sort(([left],[right])=>left<right?-1:left>right?1:0)
  const digest=createHash('sha256')
  for(const [name,hash] of entries)digest.update(name).update('\0').update(hash).update('\n')
  const actualDigest=digest.digest('hex')
  if(entries.length!==descriptor.inputs.fileCount)throw Error(`${descriptor.id} input count mismatch, expected ${descriptor.inputs.fileCount}, got ${entries.length}`)
  if(actualDigest!==descriptor.inputs.sha256)throw Error(`${descriptor.id} input hash mismatch, expected ${descriptor.inputs.sha256}, got ${actualDigest}`)
  const licenseHash=hashFile(license)
  if(licenseHash!==descriptor.license.sha256)throw Error(`${descriptor.id} license hash mismatch, expected ${descriptor.license.sha256}, got ${licenseHash}`)
  return {
    descriptor,
    directory:root,
    sources,
    headers,
    license,
    metadata:{
      id:descriptor.id,
      version:descriptor.version,
      url:descriptor.archive.url,
      sha256:descriptor.archive.sha256,
      licenseSHA256:descriptor.license.sha256,
      inputsSHA256:descriptor.inputs.sha256,
      inputFiles:descriptor.inputs.fileCount,
    },
  }
}
