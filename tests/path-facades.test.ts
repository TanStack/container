import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import path from 'node:path'

test('generated POSIX facade advertises named exports and uses the POSIX object',()=>{
  const {modules}=JSON.parse(readFileSync('public/kernel-runtime/builtins.json','utf8'))
  const entry=modules['node:path/posix']
  for(const name of ['join','resolve','normalize','parse','format','posix','win32'])expect(entry.exports).toContain(name)
  const module={exports:{} as any}
  new Function('module','exports','require',entry.cjs)(module,module.exports,(name:string)=>{
    expect(name).toBe('node:path')
    return path
  })
  expect(module.exports.default).toBe(path.posix)
  expect(module.exports.join).toBe(path.posix.join)
  expect(module.exports.join('/a','../b')).toBe('/b')
  expect(module.exports.win32).toBe(path.win32)
})
