import {t as binding} from './node_modules/rolldown/dist/shared/binding-BbrDfv1x.mjs'
import {parseCases} from './parse-cases.mjs'
const native=binding(),results=[]
for(const item of parseCases){
  const result=await native.parse(item.filename,item.source,item.options)
  results.push({name:item.name,result:{program:result.program,module:result.module,comments:result.comments,errors:result.errors}})
}
console.log(JSON.stringify(results))
