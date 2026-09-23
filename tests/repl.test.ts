import {test,expect} from 'vitest'
import native from 'node:repl'
import {PassThrough} from 'node:stream'
// @ts-expect-error Guest facade intentionally has no declaration file.
import * as guest from '../src/sandbox/guest-repl.js'

const run=async(api:any,source:string)=>{
  const input=new PassThrough(),output=new PassThrough();let text=''
  output.on('data',chunk=>text+=chunk)
  const server=api.start({input,output,terminal:false,prompt:'P> ',useColors:false})
  const exited=new Promise(resolve=>server.once('exit',resolve));input.end(source);await exited
  return text
}
test('stream REPL sync, await, multiline and built-in commands match native Node',async()=>{
  for(const source of ['1+2\n.exit\n','await Promise.resolve(7)\n.exit\n','function fixture(){\nreturn 4\n}\nfixture()\n.exit\n','.help\n.exit\n','.clear\n.exit\n'])expect(await run(guest,source),source).toBe(await run(native,source))
})
test('surface helpers and explicit terminal limitations are bounded',()=>{
  expect(guest.writer({a:1})).toBe((native as any).writer({a:1}))
  expect(guest.builtinModules).toEqual((native as any).builtinModules)
  expect(new guest.Recoverable(Error('again')).err.message).toBe('again')
  expect(()=>guest.start({terminal:true})).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
