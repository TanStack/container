import {expect,test} from 'vitest'
import {browserInlineSourceMap} from '../src/native/browser-inline-source-map'
test('reads the final Vite inline map without dropping evaluator padding or unicode',()=>{
  const first={version:3,mappings:'AAAA',sources:['old.ts']}
  const last={version:3,mappings:';;AAAA',sources:['café.ts'],sourcesContent:['const café=42']}
  const encode=(map:unknown)=>Buffer.from(JSON.stringify(map)).toString('base64')
  const code=`//# sourceMappingURL=data:application/json;base64,${encode(first)}\nconst value=42\n//# sourceMappingURL=data:application/json;base64,${encode(last)}\n`
  expect(browserInlineSourceMap(code)).toEqual(last)
  expect(browserInlineSourceMap('const value=42')).toBe(null)
  expect(browserInlineSourceMap('//# sourceMappingURL=/app/external.map')).toBe(null)
})
