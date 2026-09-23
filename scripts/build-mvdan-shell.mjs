import {mkdirSync,copyFileSync,readFileSync,writeFileSync,existsSync,lstatSync,chmodSync} from 'node:fs'
import {resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const toolchainInput=process.argv[2]??process.env.MVDAN_TOOLCHAIN
if(!toolchainInput)throw Error('Pass a Go 1.27.1 toolchain directory as the first argument or MVDAN_TOOLCHAIN. It must contain go/bin/go and the locked modules in gopath/pkg/mod.')
const toolchain=resolve(toolchainInput)
const source=resolve('shell/mvdan'),out=resolve('public/mvdan-shell')
const go=resolve(toolchain,'go/bin/go')
const version=execFileSync(go,['version'],{encoding:'utf8'}).trim()
if(!version.includes('go1.27.1'))throw Error('Expected Go 1.27.1')
mkdirSync(out,{recursive:true})
const ldflags=['-s','-w']
execFileSync(go,['build','-trimpath','-mod=readonly','-ldflags='+ldflags.join(' '),'-o',resolve(out,'shell.wasm'),'.'],{cwd:source,stdio:'inherit',env:{...process.env,GOOS:'js',GOARCH:'wasm',GOPATH:resolve(toolchain,'gopath'),GOCACHE:resolve(toolchain,'gocache'),GOPROXY:'off',GOTOOLCHAIN:'local'}})
copyFileSync(resolve(toolchain,'go/lib/wasm/wasm_exec.js'),resolve(out,'wasm_exec.js'))
copyFileSync(resolve(toolchain,'go/LICENSE'),resolve(out,'GO-LICENSE'))
const mvdanLicense=resolve(out,'MVDAN-LICENSE')
if(existsSync(mvdanLicense)){
  if(!lstatSync(mvdanLicense).isFile())throw Error('Expected a regular generated license file')
  chmodSync(mvdanLicense,0o644)
}
copyFileSync(resolve(toolchain,'gopath/pkg/mod/mvdan.cc/sh/v3@v3.14.1/LICENSE'),mvdanLicense)
chmodSync(mvdanLicense,0o644)
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
writeFileSync(resolve(out,'build.json'),JSON.stringify({version,mvdan:'3.14.1',goBuild:{trimpath:true,ldflags},sourceSHA256:hash(resolve(source,'main.go')),lockSHA256:hash(resolve(source,'go.sum')),wasmSHA256:hash(resolve(out,'shell.wasm'))},null,2)+'\n')
