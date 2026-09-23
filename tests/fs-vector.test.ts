import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../src/sandbox/guest-fs-descriptors.js',import.meta.url),'utf8')
const taskQueue=readFileSync(new URL('../src/sandbox/guest-task-queue.js',import.meta.url),'utf8')
function setup(){
 const calls:any[]=[];let cursor=0;const data=Buffer.from('abcdef')
 const host={descriptors:{call(method:string,_fd:number,value:any,position:any){calls.push(method);const offset=position??cursor;if(method==='read'){const bytes=data.subarray(offset,offset+value);if(position===null)cursor+=bytes.length;return {bytes}}if(method==='write'){data.set(value,offset);if(position===null)cursor+=value.length;return value.length}}}}
 const api=new Function('globalThis','filePath','Buffer',taskQueue+'\n'+source+';return descriptorAPI')({__webContainerHost:host,Symbol},(p:any)=>p,Buffer)
 return {api,calls,data}
}
it('vector reads advance explicit position across buffers and stop at EOF',()=>{
 const {api}=setup(),buffers=[Buffer.alloc(2),Buffer.alloc(4),Buffer.alloc(2)]
 expect(api.readvSync(7,buffers,1)).toBe(5)
 expect(Buffer.concat(buffers).subarray(0,5).toString()).toBe('bcdef')
 const next=[Buffer.alloc(1)];expect(api.readvSync(7,next,null)).toBe(1);expect(next[0].toString()).toBe('a')
})
it('prevalidates every vector entry before writes including array holes',()=>{
 for(const buffers of [[Buffer.from('Z'),{}],[Buffer.from('Z'),,]]){
  const {api,calls,data}=setup();expect(()=>api.writevSync(7,buffers,0)).toThrow();expect(calls).toEqual([]);expect(data.toString()).toBe('abcdef')
 }
})
it('vector writes preserve current offset for explicit positions',()=>{
 const {api,data}=setup();expect(api.writevSync(7,[Buffer.from('X'),Buffer.from('Y')],2)).toBe(2)
 expect(api.writevSync(7,[Buffer.from('Z')],1.5)).toBe(1);expect(data.toString()).toBe('ZbXYef')
})
it('callback vectors validate immediately and retain caller buffer identity',async()=>{
 const {api,calls}=setup(),buffers=[Buffer.from('X'),Buffer.from('Y')]
 expect(()=>api.writev(7,[buffers[0],{}],()=>{})).toThrow();expect(calls).toEqual([])
 let synchronous=true
 const pending=new Promise<void>((resolve,reject)=>api.writev(7,buffers,0,(error:any,count:number,returned:any)=>{
  try{expect(error).toBeNull();expect(synchronous).toBe(false);expect(count).toBe(2);expect(returned).toBe(buffers);resolve()}catch(error){reject(error)}
 }))
 synchronous=false;await pending
 const readBuffers=[Buffer.alloc(2)],result=await api.readv[Symbol.for('nodejs.util.promisify.custom')](7,readBuffers,0)
 expect(result.bytesRead).toBe(2);expect(result.buffers).toBe(readBuffers);expect(readBuffers[0].toString()).toBe('XY')
})
