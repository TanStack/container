import {gzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'

export function tarArchive(files:Record<string,string|{text:string;mode:number}>){
  const chunks:Buffer[]=[]
  for(const [path,value] of Object.entries(files)){
    const {text,mode}=typeof value==='string'?{text:value,mode:0o644}:value
    const body=Buffer.from(text),header=Buffer.alloc(512)
    header.write(path,0,100);header.write(mode.toString(8).padStart(7,'0')+'\0',100);header.write(body.length.toString(8).padStart(11,'0')+'\0',124)
    header.fill(32,148,156);header[156]=48;header.write('ustar\0',257)
    header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148)
    chunks.push(header,body,Buffer.alloc((512-body.length%512)%512))
  }
  return Buffer.concat([...chunks,Buffer.alloc(1024)])
}

export function npmProject(){
  const definitions=[
    {path:'node_modules/parent',name:'parent',version:'1.0.0',dependencies:{child:'2.0.0'},bin:{parent:'index.js'},source:'module.exports=require("child")+40'},
    {path:'node_modules/parent/node_modules/child',name:'child',version:'2.0.0',source:'module.exports=2'},
    {path:'node_modules/child',name:'child',version:'1.0.0',source:'module.exports=1'},
  ]
  const archives:Record<string,Buffer>={}
  const manifest={name:'ordinary-project',version:'1.0.0',dependencies:{parent:'1.0.0',child:'1.0.0'}}
  const packages:Record<string,any>={'':structuredClone(manifest)}
  for(const {path,source,...pkg} of definitions){
    const archive=gzipSync(tarArchive({'package/package.json':JSON.stringify({...pkg,main:'index.js'}),'package/index.js':source}))
    const resolved=`https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`
    archives[resolved]=archive
    packages[path]={...pkg,resolved,integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}
  }
  const lock={name:manifest.name,version:manifest.version,lockfileVersion:3,packages}
  const files={'/package.json':JSON.stringify(manifest),'/package-lock.json':JSON.stringify(lock),'/entry.cjs':'console.log(require("parent"),require("child"))','/keep.txt':'keep','/node_modules/stale/index.js':'stale'}
  return {files,manifest,lock,archives}
}
