import {expect,it} from 'vitest'
import {Console} from '../src/vite-browser/node-console'

it('formats output, separates streams, and binds extracted methods',()=>{
  const out:string[]=[],err:string[]=[]
  const console=new Console({stdout:{write:text=>out.push(text)},stderr:{write:text=>err.push(text)}})
  const log=console.log
  log('value: %d',42)
  console.error('failed: %s','bad')
  console.assert(true,'ignored')
  console.assert(false,'expected %d',5)
  expect(out).toEqual(['value: 42\n'])
  expect(err).toEqual(['failed: bad\n','Assertion failed: expected 5\n'])
})
it('validates streams and respects ignoreErrors',()=>{
  expect(()=>new Console({} as never)).toThrow(TypeError)
  const stream={write(){throw Error('write failed')}}
  expect(()=>new Console(stream).log('ignored')).not.toThrow()
  expect(()=>new Console({stdout:stream,ignoreErrors:false}).log('visible')).toThrow('write failed')
})
it('retains stack traces for error objects',()=>{
  const output:string[]=[]
  const console=new Console({write:text=>output.push(text)})
  const error=new Error('startup failed')
  console.error(error)
  expect(output).toEqual([error.stack+'\n'])
})
