import {mkdtempSync,writeFileSync,readFileSync,lstatSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'

const version='3.6.7'
const url=`https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-${version}/mbedtls-${version}.tar.bz2`
const sha256='a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6'
const directory=mkdtempSync(join(tmpdir(),'web-container-tls-source-'))
const archive=join(directory,'source.tar.bz2')
const response=await fetch(url)
if(!response.ok)throw Error(`TLS source download failed: ${response.status}`)
const bytes=Buffer.from(await response.arrayBuffer())
if(bytes.length>32*1024*1024||createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('TLS source checksum mismatch')
writeFileSync(archive,bytes)
const entries=execFileSync('tar',['-tjf',archive],{encoding:'utf8'}).trim().split('\n')
for(const name of entries)if(!name.startsWith(`mbedtls-${version}/`)||name.split('/').some(part=>part==='..')||name.includes('\\'))throw Error('Unsafe TLS archive entry')
const details=execFileSync('tar',['-tvjf',archive],{encoding:'utf8'}).trim().split('\n')
if(details.some(line=>!['d','-'].includes(line[0])))throw Error('TLS archive contains links or special files')
execFileSync('tar',['-xjf',archive,'-C',directory])
const source=join(directory,`mbedtls-${version}`)
for(const name of readdirSync(source,{recursive:true}))if(lstatSync(join(source,name)).isSymbolicLink())throw Error('Unexpected TLS source link')
const report={version,url,sha256,directory:source,licenseSHA256:createHash('sha256').update(readFileSync(join(source,'LICENSE'))).digest('hex')}
writeFileSync('reports/tls-source.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
