import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../src/sandbox/guest-fs-mkdtemp.js',import.meta.url),'utf8')
const factory=new Function(source+';return createMkdtempAPI')()
const filePath=(value:any)=>Buffer.isBuffer(value)?value.toString():String(value)
it('creates a six-character suffix with private directory mode',()=>{
  const calls:any[]=[]
  const api=factory({filePath,Buffer,mkdir:(...args:any[])=>calls.push(args),randomBytes:()=>new Uint8Array(16)})
  expect(api.create(api.prepare('/tmp/app-',undefined))).toBe('/tmp/app-AAAAAA')
  expect(calls).toEqual([['/tmp/app-AAAAAA',{mode:0o700}]])
})
it('retries an atomic name collision without overwriting the existing directory',()=>{
  const names:string[]=[];let entropy=0
  const api=factory({filePath,Buffer,randomBytes:()=>new Uint8Array(16).fill(entropy++),mkdir:(name:string)=>{names.push(name);if(names.length===1)throw Object.assign(Error('exists'),{code:'EEXIST'})}})
  expect(api.create(api.prepare('app-',null))).toBe('app-BBBBBB')
  expect(names).toEqual(['app-AAAAAA','app-BBBBBB'])
})
it('captures buffer prefixes and supports buffer result encoding',()=>{
  const api=factory({filePath,Buffer,mkdir:()=>{},randomBytes:()=>new Uint8Array(16)})
  const prefix=Buffer.from('app-'),prepared=api.prepare(prefix,{encoding:'buffer'})
  prefix.fill(120)
  expect(api.create(prepared)).toEqual(Buffer.from('app-AAAAAA'))
})
it('validates encoding before creation and preserves filesystem errors',()=>{
  let calls=0
  const error=Object.assign(Error('missing parent'),{code:'ENOENT'})
  const api=factory({filePath,Buffer,mkdir:()=>{calls++;throw error},randomBytes:()=>new Uint8Array(16)})
  expect(()=>api.prepare('app-',42)).toThrowError(expect.objectContaining({code:'ERR_INVALID_ARG_TYPE'}))
  expect(()=>api.prepare('app-','not-an-encoding')).toThrowError(expect.objectContaining({code:'ERR_INVALID_ARG_VALUE'}))
  expect(calls).toBe(0)
  expect(()=>api.create(api.prepare('missing/app-'))).toThrow(error)
  expect(calls).toBe(1)
})
