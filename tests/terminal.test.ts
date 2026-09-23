import {it,expect} from 'vitest'
import {VirtualTerminal,terminalOptions} from '../src/sandbox/terminal'
import {readFileSync} from 'node:fs'
it('provides cooked line buffering and echo, then raw input without echo',async()=>{
 const input:number[][]=[],output:number[][]=[];let interrupted=false
 const terminal=new VirtualTerminal({columns:80,rows:24},async bytes=>{input.push([...bytes])},async bytes=>{output.push([...bytes])},()=>{interrupted=true})
 await terminal.write(new TextEncoder().encode('ab\x7fc\r'))
 expect(input).toEqual([[97,99,10]])
 expect(output.flat()).toEqual([97,98,8,32,8,99,13,10])
 terminal.setRawMode(true);await terminal.write(new Uint8Array([3,27,91,65]))
 expect(input[1]).toEqual([3,27,91,65]);expect(interrupted).toBe(false)
 terminal.setRawMode(false);await terminal.write(new Uint8Array([3]));expect(interrupted).toBe(true)
})
it('keeps ordinary pipes untouched and decorates only a real attached transport',()=>{
 const decorate=new Function(readFileSync('src/sandbox/guest-tty.js','utf8')+';return attachTerminal')()
 const process:any={stdin:{},stdout:{},stderr:{}}
 decorate(process,{proc:{call:()=>null}});expect(process.stdin.isTTY).toBeUndefined()
 const calls:unknown[][]=[]
 decorate(process,{proc:{call:(...args:unknown[])=>{calls.push(args);return {columns:80,rows:24,raw:false}}}})
 expect(process.stdin.setRawMode(true)).toBe(process.stdin)
 expect(process.stdin.isRaw).toBe(true);expect(calls.at(-1)).toEqual(['terminalRaw',true])
 expect(process.stdout.getWindowSize()).toEqual([80,24])
 expect(process.stdout.isTTY).toBe(true)
})
it('validates bounded explicit dimensions',()=>{
 expect(terminalOptions(undefined)).toBeUndefined()
 expect(terminalOptions({columns:80,rows:24})).toEqual({columns:80,rows:24})
 for(const value of [true,{}, {columns:0,rows:24},{columns:80,rows:1001}])expect(()=>terminalOptions(value)).toThrow()
})
