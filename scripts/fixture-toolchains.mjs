import {readFileSync,realpathSync,statSync,accessSync,constants} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..')
export const WASM3_REVISION='5fe766c933c7595d728d6172bb1a197607d85b4e'
const assemblers={
  wat2wasm:'ec365944cb1ebeb07f18140c66118c1b64fb49ca90d5a024ddb0dc82e35cbae8',
  wast2json:'41c556337229c66dc19f5498cb99e9a4a221b31cfdb0a43689693714ec44f67d',
}
function checked(value,label,directory){
  if(typeof value!=='string'||!value.trim())throw Error(label+' must be a nonempty path')
  const path=resolve(value)
  let stat
  try{stat=statSync(path)}catch{throw Error(label+' is missing: '+path+'. Follow patches/README.md toolchain setup or configure the explicit path.')}
  if(directory?!stat.isDirectory():!stat.isFile())throw Error(label+' has the wrong file type: '+path)
  return realpathSync(path)
}
export function resolveWasm3Source({source,environment=process.env,projectRoot=repository}={}){
  return checked(source??environment.WASM3_SOURCE_ROOT??join(projectRoot,'.toolchains/wasm3'),'WASM3_SOURCE_ROOT',true)
}
export function resolveEmscripten({compiler,environment=process.env,projectRoot=repository}={}){
  const path=checked(compiler??environment.EMCC??join(projectRoot,'.toolchains/emsdk/upstream/emscripten/emcc'),'EMCC',false)
  try{accessSync(path,constants.X_OK)}catch{throw Error('EMCC is not executable: '+path)}
  return path
}
export function fixtureAssembler(tool='wat2wasm',options={}){
  if(!Object.hasOwn(assemblers,tool))throw Error('Unsupported fixture assembler: '+tool)
  const source=resolveWasm3Source(options),assembler=checked(join(source,'test/wasi/wabt',tool+'.wasm'),'Pinned '+tool,false)
  const sha256=createHash('sha256').update(readFileSync(assembler)).digest('hex')
  if(sha256!==assemblers[tool])throw Error('Unexpected pinned '+tool+' SHA256: '+sha256)
  return {assembler,sha256,revision:WASM3_REVISION,command:process.execPath,prefix:[join(repository,'scripts/assemble-wat.mjs'),'--tool='+tool,'--wasm3-root='+source]}
}
