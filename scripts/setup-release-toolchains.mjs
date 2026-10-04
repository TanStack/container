import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {lstatSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'

export const releaseToolchainPins=Object.freeze({
  go:'1.27.1',
})

export function releaseToolchainPlan(root=process.cwd(),platform=process.platform,arch=process.arch){
  assert.equal(platform,'linux','Release toolchain setup requires Linux')
  const goArch={x64:'amd64',arm64:'arm64'}[arch]
  assert.ok(goArch,'Release toolchain setup requires Linux x64 or ARM64')
  root=resolve(root)
  const directory=join(root,'.toolchains')
  return {root,directory,sources:[],clones:[],goFilename:`go${releaseToolchainPins.go}.linux-${goArch}.tar.gz`}
}

export function verifyDownload(bytes,expected){
  assert.match(expected,/^[a-f0-9]{64}$/)
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,'Downloaded archive checksum mismatch')
}

export function selectGoDownload(releases,filename){
  const arch=['amd64','arm64'].find(arch=>filename===`go${releaseToolchainPins.go}.linux-${arch}.tar.gz`)
  assert.ok(arch,'Use the pinned Linux x64 or ARM64 Go archive')
  const release=releases.find(item=>item.version===`go${releaseToolchainPins.go}`)
  const archive=release?.files.find(item=>item.filename===filename&&item.os==='linux'&&item.arch===arch&&item.kind==='archive')
  assert.ok(archive,`Official Go release metadata does not contain ${filename}`)
  assert.match(archive.sha256,/^[a-f0-9]{64}$/)
  return archive
}

async function download(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(300_000)})
  assert.ok(response.ok,`Download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function setupReleaseToolchains({root=process.cwd(),run=execFileSync}={}){
  const plan=releaseToolchainPlan(root)
  // A failed setup is retained for diagnosis. Never replace an existing checkout.
  const destinations=[join(plan.directory,'go-sdk'),join(plan.directory,'release-downloads')]
  const parent=lstatSync(plan.directory,{throwIfNoEntry:false})
  assert.ok(!parent||(parent.isDirectory()&&!parent.isSymbolicLink()),'Toolchain root must be a real directory')
  for(const destination of destinations)assert.ok(!lstatSync(destination,{throwIfNoEntry:false}),`Toolchain destination already exists: ${destination}`)
  mkdirSync(plan.directory,{recursive:true})
  const downloads=join(plan.directory,'release-downloads')
  mkdirSync(downloads)
  async function extract(url,sha256,destination,filename,strip){
    const bytes=await download(url)
    verifyDownload(bytes,sha256)
    const archive=join(downloads,filename)
    writeFileSync(archive,bytes,{flag:'wx'})
    mkdirSync(destination)
    run('tar',['-xf',archive,'-C',destination,...(strip?['--strip-components=1']:[])],{stdio:'inherit'})
  }
  const releases=JSON.parse((await download('https://go.dev/dl/?mode=json&include=all')).toString('utf8'))
  const go=selectGoDownload(releases,plan.goFilename)
  const goRoot=join(plan.directory,'go-sdk')
  await extract(`https://go.dev/dl/${plan.goFilename}`,go.sha256,goRoot,plan.goFilename,false)
  run(join(goRoot,'go/bin/go'),['-C',join(plan.root,'shell/mvdan'),'mod','download'],{stdio:'inherit',env:{...process.env,GOPATH:join(goRoot,'gopath'),GOCACHE:join(goRoot,'gocache'),GOTOOLCHAIN:'local'}})
  const oxide=JSON.parse(readFileSync(join(plan.root,'build-inputs/native-oxide.json'),'utf8'))
  run('rustup',['toolchain','install',oxide.rustVersion,'--profile','minimal'],{stdio:'inherit'})
  run('rustup',['target','add','--toolchain',oxide.rustVersion,oxide.target],{stdio:'inherit'})
  return plan
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await setupReleaseToolchains()
