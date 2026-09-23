import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {t as binding} from './node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs'
import {compile,files} from './compile.mjs'
import {callback} from './plugin.mjs'
const cwd=mkdtempSync(join(tmpdir(),'rolldown-reference-'))
for(const [path,source]of Object.entries(files))writeFileSync(join(cwd,path.split('/').pop()),source)
const rounds=[]
for(const value of [39,40]){
  writeFileSync(join(cwd,'value.js'),'export default '+value)
  const chunks=await compile(binding(),callback,cwd)
  const result=await import('data:text/javascript;base64,'+Buffer.from(chunks[0].code).toString('base64'))
  rounds.push({value:result.default,chunks})
}
console.log(JSON.stringify({rounds}))
