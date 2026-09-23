import {describe,it,expect} from 'vitest'
import {builtinModules} from '../src/compiler/builtins'

const source=builtinModules['node:fs/promises']
const handleSource=source.slice(source.indexOf('class FileHandle {'),source.indexOf('export const open='))
describe('FileHandle operation lifetime',()=>{
  it('writeFile chunks bounded writes and retains the descriptor through close',async()=>{
    const lengths:number[]=[],events:string[]=[];let total=0
    const descriptor={task:async(fn:any,...args:any[])=>{await Promise.resolve();return fn(...args)},writeSync:(_fd:number,_data:any,_offset:number,length:number,position:any)=>{expect(position).toBeNull();lengths.push(length);total+=length;events.push('write');return length},closeSync:()=>events.push('close')}
    const FileHandle=new Function('descriptorAPI','Buffer',handleSource+';return FileHandle')(descriptor,Buffer)
    const handle=new FileHandle(7),write=handle.writeFile('x'.repeat(70000)),close=handle.close();expect(await write).toBeUndefined();await close
    expect(total).toBe(70000);expect(lengths).toEqual([65536,4464]);expect(events).toEqual(['write','write','close'])
  })
  it('writeFile rejects unsupported iterable input explicitly',async()=>{
    const FileHandle=new Function('descriptorAPI','Buffer',handleSource+';return FileHandle')({},Buffer)
    await expect(new FileHandle(7).writeFile(['a','b'])).rejects.toMatchObject({code:'ERR_UNSUPPORTED_OPERATION'})
  })
  it('keeps vector operations admitted until their single task completes',async()=>{
    const events:string[]=[],buffers=[Buffer.from('a'),Buffer.from('b')]
    const descriptor={vectorViews:(buffers:any[])=>buffers.slice(),task:async(fn:any,...args:any[])=>{await Promise.resolve();return fn(...args)},writevSync:()=>{events.push('writev');return 2},readvSync:()=>{events.push('readv');return 2},closeSync:()=>events.push('close')}
    const FileHandle=new Function('descriptorAPI','Buffer',handleSource+';return FileHandle')(descriptor,Buffer)
    const handle=new FileHandle(7),write=handle.writev(buffers),read=handle.readv(buffers,0),close=handle.close()
    expect((await write).buffers).toBe(buffers);expect((await read).buffers).toBe(buffers);await close
    expect(events).toEqual(['writev','readv','close']);expect(handle.fd).toBe(-1)
  })
  it('captures vector views during admission rather than task execution',async()=>{
    const original=Buffer.from('ab'),buffers=[original];let admitted:any[]=[]
    const descriptor={vectorViews:(buffers:any[])=>buffers.slice(),task:async(fn:any,...args:any[])=>{await Promise.resolve();return fn(...args)},writevSync:(_fd:number,views:any[])=>{admitted=views;return 2}}
    const FileHandle=new Function('descriptorAPI','Buffer',handleSource+';return FileHandle')(descriptor,Buffer)
    const handle=new FileHandle(7),pending=handle.writev(buffers);buffers[0]=Buffer.from('XY')
    expect((await pending).buffers).toBe(buffers);expect(admitted).not.toBe(buffers);expect(admitted[0]).toBe(original)
  })
  it('retains the descriptor across a multistep read and closes once afterward',async()=>{
    const events:string[]=[];let count=0,closed=false
    const descriptor={task:async(fn:(...args:any[])=>unknown,...args:any[])=>{await Promise.resolve();return fn(...args)},
      readSync:(fd:number,buffer:Buffer)=>{expect(fd).toBe(7);expect(closed).toBe(false);events.push('read');if(count++===0){buffer.write('alpha');return 5}return 0},
      closeSync:(fd:number)=>{expect(fd).toBe(7);closed=true;events.push('close')},fstatSync:()=>({size:5})}
    const FileHandle=new Function('descriptorAPI','Buffer',handleSource+';return FileHandle')(descriptor,Buffer)
    const handle=new FileHandle(7),read=handle.readFile('utf8'),close=handle.close(),again=handle.close()
    expect(handle.fd).toBe(7);expect(again).toBe(close)
    await expect(handle.stat()).resolves.toEqual({size:5})
    expect(await read).toBe('alpha');await close
    expect(handle.fd).toBe(-1)
    await expect(handle.stat()).rejects.toMatchObject({code:'EBADF'})
    expect(events).toEqual(['read','read','close'])
  })
  it('releases an operation that rejects so close can finish',async()=>{
    const error=Error('read failed');let closed=false
    const descriptor={task:async(fn:(...args:any[])=>unknown,...args:any[])=>{await Promise.resolve();return fn(...args)},readSync:()=>{throw error},closeSync:()=>{closed=true}}
    const FileHandle=new Function('descriptorAPI','Buffer',handleSource+';return FileHandle')(descriptor,Buffer)
    const handle=new FileHandle(7),read=handle.readFile(),close=handle.close()
    await expect(read).rejects.toBe(error);await close;expect(closed).toBe(true)
  })
})
