import {expect,test} from 'vitest'
import {browserModuleSource} from '../src/native/browser-module-function'
test('removes only the generated Vite trailer, preserving every code line',()=>{
  const code='const owned=`\n//# sourceURL=customer\n`;\nexports.value=owned;'
  const trailer='\n//# sourceURL=/app/owned.js\n//# sourceMappingSource=vite-generated\n//# sourceMappingURL=data:application/json;base64,e30=\n'
  const source=browserModuleSource(['exports'],code+trailer)
  expect(source).toContain(code)
  expect(source).not.toContain('sourceURL=/app/owned.js')
  expect(source).not.toContain('base64,e30=')
  expect(source.split('\n').length).toBe((code+trailer).split('\n').length+3)
})
