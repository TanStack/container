import {expect,test} from 'vitest'
import {BrowserSourceLocations} from '../src/native/browser-source-locations'

test('maps only captured registered locations in browser stack formats',()=>{
  const sources=new BrowserSourceLocations()
  sources.register('blob:http://localhost/owned',(line,column)=>line>2?{file:'/app/entry.js',line:line-2,column}:null)
  const stack='Error: owned\n    at capture (blob:http://localhost/owned:5:9)\ncapture@blob:http://localhost/owned:5:9\nunknown@blob:http://localhost/other:5:9\nwrapper@blob:http://localhost/owned:1:9\nmissing@'
  expect(sources.mapStack(stack)).toBe('Error: owned\n    at capture (/app/entry.js:3:9)\ncapture@/app/entry.js:3:9\nunknown@blob:http://localhost/other:5:9\nwrapper@blob:http://localhost/owned:1:9\nmissing@')
})
test('supports composed mappings and unregistering without inventing positions',()=>{
  const sources=new BrowserSourceLocations()
  const unregister=sources.register('blob:owned',()=>({file:'/app/original.ts',line:7,column:4}))
  expect(()=>sources.register('blob:owned',()=>null)).toThrow('already registered')
  expect(sources.mapStack('capture@blob:owned:8:20')).toBe('capture@/app/original.ts:7:4')
  unregister()
  expect(sources.mapStack('capture@blob:owned:8:20')).toBe('capture@blob:owned:8:20')
  sources.register('blob:owned',()=>({file:'/app/original.ts',line:0,column:4}))
  expect(sources.mapStack('capture@blob:owned:8:20')).toBe('capture@blob:owned:8:20')
})
