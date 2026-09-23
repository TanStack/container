import {createHash} from 'node:crypto'
import {readFileSync,readdirSync,lstatSync,realpathSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve,basename,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {assembleCompilerAssets} from './compiler-assets.mjs'

const root=dirname(fileURLToPath(import.meta.url))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const safe=path=>typeof path==='string'&&!path.includes('\\')&&!path.startsWith('/')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..')
function verifyPackage(){
  const bytes=readFileSync(join(root,'package-assets.json')),manifest=JSON.parse(bytes)
  if(manifest.format!==1||!Array.isArray(manifest.files))throw Error('Invalid runtime package manifest')
  const seen=new Set()
  for(const file of manifest.files){
    if(!safe(file.path)||seen.has(file.path))throw Error('Invalid runtime package path')
    seen.add(file.path)
    let current=root
    for(const part of file.path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Runtime package symlink: '+file.path)}
    if(!lstatSync(current).isFile())throw Error('Expected runtime package file: '+file.path)
    const value=readFileSync(current)
    if(value.length!==file.bytes||hash(value)!==file.sha256)throw Error('Runtime package hash mismatch: '+file.path)
  }
  function inventory(directory,prefix=''){
    for(const name of readdirSync(directory)){
      const path=prefix?prefix+'/'+name:name
      // npm can install nested dependencies here. They have their own package
      // boundary and are validated by compiler-assets, not trusted as our files.
      if(!prefix&&name==='node_modules')continue
      const stat=lstatSync(join(directory,name))
      if(stat.isSymbolicLink())throw Error('Runtime package symlink: '+path)
      if(stat.isDirectory())inventory(join(directory,name),path)
      else if(!stat.isFile()||(path!=='package-assets.json'&&!seen.has(path)))throw Error('Unlisted runtime package file: '+path)
    }
  }
  inventory(root)
  return {manifest,sha256:hash(bytes)}
}
export function readPreviewHostHostingContract(){verifyPackage();return json(join(root,'preview-host/hosting.json'))}
export function readRuntimeProfileManifest(){verifyPackage();return json(join(root,'runtime-profile.json'))}

/** Generate a browser deployment, not an npm package. No downloads or lifecycle scripts. */
export async function prepareRuntimeAssets(destination){
  if(typeof destination!=='string'||!destination||destination.includes('\0'))throw TypeError('Expected a new destination directory')
  const verified=verifyPackage(),requested=resolve(destination),parent=realpathSync(dirname(requested)),target=join(parent,basename(requested))
  const inside=relative(realpathSync(root),target)
  if(!inside||(!inside.startsWith('..'+sep)&&inside!=='..'))throw Error('Destination must be outside the runtime package')
  // mkdir refuses existing directories and symlinks. Failed assembly is left for inspection.
  mkdirSync(target)
  const config=json(join(root,'compiler-config.json'))
  const assembled=await assembleCompilerAssets(join(target,'runtime'),{
    resolveFrom:import.meta.url,compilerArtifact:config.compilerArtifact,
    ...(config.parserInputs?{parserInputs:config.parserInputs,parserEntry:join(root,'adapter/worker.mjs')}:{})})
  for(const file of verified.manifest.files){
    if(!file.path.startsWith('runtime/')&&!file.path.startsWith('preview-host/')&&!file.path.startsWith('licenses/')&&!['kernel-host.js','kernel-host.html'].includes(file.path))continue
    const output=join(target,file.path)
    mkdirSync(dirname(output),{recursive:true})
    try{copyFileSync(join(root,file.path),output,1)}catch(error){
      if(error.code!=='EEXIST'||hash(readFileSync(output))!==file.sha256)throw error
    }
  }
  if(assembled.parser&&config.parserPolicy){
    const artifact={...config.parserPolicy,assets:assembled.parser.assets,sources:assembled.parser.sources??{}}
    writeFileSync(join(target,'runtime/rolldown-parser/artifact.json'),JSON.stringify(artifact,null,2)+'\n')
  }
  const files=[]
  function visit(directory,prefix=''){
    for(const name of readdirSync(directory).sort()){
      const path=prefix?prefix+'/'+name:name,absolute=join(directory,name),stat=lstatSync(absolute)
      if(stat.isSymbolicLink())throw Error('Deployment symlink: '+path)
      if(stat.isDirectory())visit(absolute,path)
      else if(stat.isFile()){const bytes=readFileSync(absolute);files.push({path,bytes:bytes.length,sha256:hash(bytes)})}
      else throw Error('Unsupported deployment file: '+path)
    }
  }
  visit(target)
  const manifestPath=join(target,'deployment-manifest.json')
  writeFileSync(manifestPath,JSON.stringify({format:1,packageManifestSHA256:verified.sha256,files},null,2)+'\n',{flag:'wx'})
  return {directory:target,runtimeDirectory:join(target,'runtime'),previewHostDirectory:join(target,'preview-host'),kernelHostPath:join(target,'kernel-host.html'),manifestPath}
}
