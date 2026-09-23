import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {lstatSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs'
import {basename,dirname,relative,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {gzipSync,gunzipSync} from 'node:zlib'

const excludedDirectories=new Set([
  '.git','.agents','.codex','.npm-cache','.pnpm-store','.svelte-kit','.tanstack','.toolchains',
  'coverage','dist','node_modules','playwright-report','public','reports','test-results',
])
const excludedFiles=new Set(['.DS_Store','.npmrc','.netrc','node_trace.1.log'])
const safeEnvironmentExamples=/^\.env\.(?:example|sample|template)$/i
const sensitiveName=/(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens)(?:[._-]|$)/i
const sensitiveExtension=/\.(?:key|pem|p12|pfx|jks)$/i

function excluded(path,isDirectory){
  const parts=path.split('/')
  if(parts.some(part=>excludedDirectories.has(part)))return true
  if(parts[0]==='fixtures'&&/^native-start-(?:control|optimizer)-/.test(parts[1]??''))return true
  if(parts.slice(0,3).join('/')==='fixtures/workloads/generated')return true
  // prepare-workloads regenerates these with paths for the current checkout.
  if(/^fixtures\/workloads\/projects\/[^/]+\/reference-bootstrap\.mjs$/.test(path))return true
  const name=parts.at(-1)
  if(excludedFiles.has(name))return true
  if(!isDirectory&&name.startsWith('.env')&&name!=='.env.example'&&!safeEnvironmentExamples.test(name))return true
  return !isDirectory&&(sensitiveName.test(name)||sensitiveExtension.test(name))
}

export function listSourceSnapshotFiles(root){
  const directory=realpathSync(resolve(root)),files=[]
  function visit(current){
    for(const name of readdirSync(current).sort()){
      const absolute=resolve(current,name),path=relative(directory,absolute).split(sep).join('/'),stat=lstatSync(absolute)
      if(excluded(path,stat.isDirectory()))continue
      assert.ok(!stat.isSymbolicLink(),`Source snapshot refuses symbolic links: ${path}`)
      if(stat.isDirectory())visit(absolute)
      else if(stat.isFile())files.push({absolute,path,mode:stat.mode&0o111?0o755:0o644})
      else throw Error(`Source snapshot refuses unsupported filesystem entry: ${path}`)
    }
  }
  visit(directory)
  assert.ok(files.length>0,'Source snapshot cannot be empty')
  return files
}

function octal(value,length){
  const text=value.toString(8)
  assert.ok(text.length<=length-1,`Tar value is too large: ${value}`)
  return text.padStart(length-1,'0')+'\0'
}
function put(header,offset,length,value){
  const bytes=Buffer.from(value)
  assert.ok(bytes.length<=length,`Tar field is too long: ${value}`)
  bytes.copy(header,offset)
}
function splitTarPath(path){
  if(Buffer.byteLength(path)<=100)return {name:path,prefix:''}
  for(let index=path.lastIndexOf('/');index>0;index=path.lastIndexOf('/',index-1)){
    const prefix=path.slice(0,index),name=path.slice(index+1)
    if(Buffer.byteLength(prefix)<=155&&Buffer.byteLength(name)<=100)return {name,prefix}
  }
  throw Error(`Source path cannot be represented by the portable tar format: ${path}`)
}
function header(path,size,mode){
  const block=Buffer.alloc(512),parts=splitTarPath(path)
  put(block,0,100,parts.name);put(block,100,8,octal(mode,8));put(block,108,8,octal(0,8));put(block,116,8,octal(0,8))
  put(block,124,12,octal(size,12));put(block,136,12,octal(0,12));block.fill(0x20,148,156);block[156]=0x30
  put(block,257,6,'ustar\0');put(block,263,2,'00');put(block,345,155,parts.prefix)
  put(block,148,8,octal(block.reduce((sum,value)=>sum+value,0),8))
  return block
}

function buildSourceSnapshot(root){
  const directory=realpathSync(resolve(root))
  const prefix='web-container-source',chunks=[],files=listSourceSnapshotFiles(directory)
  for(const file of files){
    const bytes=readFileSync(file.absolute),path=`${prefix}/${file.path}`
    chunks.push(header(path,bytes.length,file.mode),bytes)
    const padding=(512-bytes.length%512)%512
    if(padding)chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  const tar=Buffer.concat(chunks)
  const archive=gzipSync(tar,{level:9,mtime:0})
  archive[9]=255
  return {archive,tar,files:files.length,sha256:createHash('sha256').update(archive).digest('hex'),tarSHA256:createHash('sha256').update(tar).digest('hex')}
}

export function verifySourceSnapshot(root,archivePath){
  const expected=buildSourceSnapshot(root),actual=readFileSync(realpathSync(resolve(archivePath)))
  // gzip bytes can differ across zlib versions. Compare every canonical tar
  // byte, including metadata and padding, but retain the supplied archive's
  // own digest as its downloadable artifact identity.
  let tar
  try{tar=gunzipSync(actual,{maxOutputLength:expected.tar.length+1})}
  catch(cause){throw new Error('Source archive does not match the current source tree: invalid or oversized gzip',{cause})}
  assert.deepEqual(tar,expected.tar,'Source archive does not match the current source tree')
  const sha256=createHash('sha256').update(actual).digest('hex')
  return {revision:`sha256:${sha256}`,sha256,tarSHA256:expected.tarSHA256,bytes:actual.length,files:expected.files}
}

export function createSourceSnapshot(root,output){
  const directory=realpathSync(resolve(root)),requested=resolve(output)
  const destination=resolve(realpathSync(dirname(requested)),basename(requested))
  assert.notEqual(destination,directory,'Source snapshot output must be a file')
  const relativeOutput=relative(directory,destination)
  assert.ok(relativeOutput.startsWith('..'+sep)||relativeOutput==='..','Source snapshot output must be outside the source tree')
  const built=buildSourceSnapshot(directory),archive=built.archive
  writeFileSync(destination,archive,{flag:'wx'})
  return {format:1,kind:'source-archive',revision:`sha256:${built.sha256}`,archive:{file:basename(destination),sha256:built.sha256,bytes:archive.length},tarSHA256:built.tarSHA256,compression:{node:process.versions.node,zlib:process.versions.zlib},files:built.files}
}

const invoked=process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)
if(invoked){
  assert.equal(process.argv.length,4,'Usage: node scripts/source-snapshot.mjs SOURCE_DIRECTORY OUTPUT.tar.gz')
  process.stdout.write(JSON.stringify(createSourceSnapshot(process.argv[2],process.argv[3]),null,2)+'\n')
}
