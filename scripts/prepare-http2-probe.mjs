import {mkdtempSync,writeFileSync,readFileSync,lstatSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'

const version='1.70.0'
const url=`https://github.com/nghttp2/nghttp2/releases/download/v${version}/nghttp2-${version}.tar.bz2`
// Published in the release's checksums.txt, checked before extraction.
const sha256='8faca1f78aa99ac3bc1768a76b7e0f6b36d8e6a62c13818751b1d205f02f9405'
const directory=mkdtempSync(join(tmpdir(),'web-container-http2-source-'))
const archive=join(directory,'source.tar.bz2')
const response=await fetch(url)
if(!response.ok)throw Error(`HTTP/2 source download failed: ${response.status}`)
const bytes=Buffer.from(await response.arrayBuffer())
if(bytes.length>32*1024*1024||createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('HTTP/2 source checksum mismatch')
writeFileSync(archive,bytes)
const entries=execFileSync('tar',['-tjf',archive],{encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n')
for(const name of entries)if(!name.startsWith(`nghttp2-${version}/`)||name.split('/').some(part=>part==='..')||name.includes('\\'))throw Error('Unsafe HTTP/2 archive entry')
const details=execFileSync('tar',['-tvjf',archive],{encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n')
if(details.some(line=>!['d','-'].includes(line[0])))throw Error('HTTP/2 archive contains links or special files')
execFileSync('tar',['-xjf',archive,'-C',directory])
const source=join(directory,`nghttp2-${version}`)
for(const name of readdirSync(source,{recursive:true}))if(lstatSync(join(source,name)).isSymbolicLink())throw Error('Unexpected HTTP/2 source link')
const report={version,url,sha256,directory:source,licenseSHA256:createHash('sha256').update(readFileSync(join(source,'COPYING'))).digest('hex')}
writeFileSync('reports/http2-source.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
