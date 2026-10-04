import {test,expect} from 'vitest'
import {dataModuleId,dataModuleURL,dataModuleSource} from '../src/native/data-module'
test('data module identities preserve URL fragments and source encodings',()=>{
  const url='data:text/javascript,export%20default%20%22hello%22#identity'
  expect(dataModuleURL(dataModuleId(url))).toBe(url)
  expect(dataModuleSource(url)).toBe('export default "hello"')
  expect(dataModuleSource('data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgNDI=')).toBe('export default 42')
  expect(dataModuleURL('/app/module.mjs')).toBeUndefined()
  expect(()=>dataModuleSource('data:text/plain,hello')).toThrow(expect.objectContaining({code:'ERR_UNKNOWN_MODULE_FORMAT'}))
  expect(()=>dataModuleSource('data:text/ecmascript,export default 42')).toThrow(expect.objectContaining({code:'ERR_UNKNOWN_MODULE_FORMAT'}))
})
test('data module byte decoding matches Node for malformed UTF-8 and literal percent signs',async()=>{
  expect(dataModuleSource('data:text/javascript,%EF%BB%BFexport default 42')).toBe('\uFEFFexport default 42')
  for(const payload of ['%22%FF%22','%22%oops%22','%22%E2%82%22','%22caf%C3%A9%22']){
    const url='data:text/javascript,export default '+payload
    const native=await import(/* @vite-ignore */ url)
    const source=dataModuleSource(url)
    const decoded=await import(/* @vite-ignore */ ('data:text/javascript,'+encodeURIComponent(source)))
    expect(decoded.default).toBe(native.default)
  }
})
