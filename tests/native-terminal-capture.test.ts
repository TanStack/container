import {expect,it} from 'vitest'
import {NativeTerminalCapture} from '../src/native/terminal-capture'
it('shares a retained byte budget between stdout and stderr',()=>{
  const capture=new NativeTerminalCapture(5)
  capture.write('out','stdout');capture.write('error','stderr');capture.write('more','stdout')
  expect(capture.finish()).toEqual({stdout:'out',stderr:'er',truncated:true})
})
it('counts UTF8 bytes rather than characters',()=>{
  const capture=new NativeTerminalCapture(4)
  capture.write('éé','stdout');capture.write('x','stderr')
  expect(capture.finish()).toEqual({stdout:'éé',stderr:'',truncated:true})
})
it('omits a partial UTF8 character at the byte limit instead of growing output with a replacement character',()=>{
  for(const [limit,text,expected] of [[1,'é',''],[3,'😀',''],[4,'a😀','a']] as const){
    const capture=new NativeTerminalCapture(limit)
    capture.write(text,'stdout')
    const result=capture.finish()
    expect(result).toEqual({stdout:expected,stderr:'',truncated:true})
    expect(new TextEncoder().encode(result.stdout).length).toBeLessThanOrEqual(limit)
  }
})
it('reports complete output without truncation and rejects invalid limits',()=>{
  const capture=new NativeTerminalCapture(4)
  capture.write('out','stdout');capture.write('!','stderr')
  expect(capture.finish()).toEqual({stdout:'out',stderr:'!',truncated:false})
  for(const limit of [0,-1,Infinity,1.5,16777217])expect(()=>new NativeTerminalCapture(limit)).toThrow('maxTerminalOutputBytes')
})
