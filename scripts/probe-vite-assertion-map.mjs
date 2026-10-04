import {createServer,moduleRunnerTransform} from 'vite8-browser'
import {TraceMap,originalPositionFor} from '@jridgewell/trace-mapping'
import {resolve} from 'node:path'
import {strict as assert} from 'node:assert'

const root=resolve(process.argv.slice(2).find(argument=>!['--strict','--build-sourcemap'].includes(argument))??'/private/tmp/container-vitest5-inspect-5VngZP')
const id=root+'/assertion-map-control.js'
const source='import {test,expect} from "vitest";test("expected failure",()=>expect(1).toBe(2))'
function inspect(result){
  const lines=result.code.split('\n')
  const line=lines.findIndex(value=>value.includes('.toBe('))
  const column=lines[line].indexOf('toBe')
  return {code:result.code,map:result.map,generated:{line:line+1,column},
    original:originalPositionFor(new TraceMap(result.map),{line:line+1,column}),
    expectedOriginalColumn:source.indexOf('toBe')}
}
const server=await createServer({root,configFile:false,server:{middlewareMode:true},
  ...(process.argv.includes('--build-sourcemap')?{build:{sourcemap:true}}:{}),
  plugins:[{name:'assertion-map-control',resolveId(request){if(request===id||request==='/assertion-map-control.js')return id},load(request){if(request===id)return source}}],
  ssr:{noExternal:true}})
try{
  const direct=await moduleRunnerTransform(source,null,id,source)
  const pipeline=await server.environments.ssr.transformRequest('/assertion-map-control.js')
  console.log(JSON.stringify({direct:inspect(direct),pipeline:inspect(pipeline)},null,2))
  if(process.argv.includes('--strict')){
    assert.equal(inspect(direct).original.column,source.indexOf('toBe'))
    assert.equal(inspect(pipeline).original.column,source.indexOf('toBe'),'Vite server pipeline must preserve the assertion column')
  }
}finally{await server.close()}
