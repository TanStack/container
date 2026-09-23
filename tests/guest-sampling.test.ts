import {expect,test,vi} from 'vitest'
import {createGuestSamplingReader,createGuestSamplingBoundaries,type GuestSamplingModule} from '../src/sandbox/guest-sampling'

function fixture(){
  let rows:number[][]=[]
  const module:GuestSamplingModule={
    HEAPU8:new Uint8Array(1024),
    _QJS_GuestSamplingReset:vi.fn(()=>1),
    _QJS_GuestSamplingCount:()=>rows.length,
    _QJS_GuestSamplingRead:(_rt,index,field)=>rows[index][field],
    _QJS_GuestSamplingText:(_rt,_index,kind)=>kind?200:100,
  }
  module.HEAPU8!.set(new TextEncoder().encode('hello'),100)
  module.HEAPU8!.set(new TextEncoder().encode('app.js'),200)
  const set=(sequences:number[])=>{rows=sequences.map(sequence=>[sequence,2,10,0,5,6,sequence])}
  return {module,set,get rows(){return rows}}
}

test('default engines have no reader and partial ABI does not allocate',()=>{
  expect(createGuestSamplingReader({},1)).toBeUndefined()
  const reset=vi.fn()
  expect(createGuestSamplingReader({_QJS_GuestSamplingReset:reset},1)).toBeUndefined()
  expect(reset).not.toHaveBeenCalled()
})

test('reads incremental samples and reports overwritten ring entries',()=>{
  const f=fixture(),reader=createGuestSamplingReader(f.module,7)!
  f.set([1,2]);expect(reader.snapshot()).toMatchObject({dropped:0,samples:[{sequence:1},{sequence:2}]})
  expect(reader.snapshot()).toEqual({dropped:0,samples:[]})
  f.set([5,6]);expect(reader.snapshot()).toMatchObject({dropped:2,samples:[{sequence:5},{sequence:6}]})
  expect(f.module._QJS_GuestSamplingReset).toHaveBeenCalledExactlyOnceWith(7,1)
  reader.close();reader.close()
  expect(f.module._QJS_GuestSamplingReset).toHaveBeenCalledTimes(2)
  expect(f.module._QJS_GuestSamplingReset).toHaveBeenLastCalledWith(7,0)
  expect(reader.snapshot().error).toContain('closed')
})

test('copies text from current heap immediately and retains no heap views',()=>{
  const f=fixture();f.set([1])
  f.module._QJS_GuestSamplingText=(_rt,_index,kind)=>{
    const grown=new Uint8Array(f.module.HEAPU8!.length+256)
    grown.set(f.module.HEAPU8!);f.module.HEAPU8= grown
    if(kind)grown.fill(120,100,105)
    return kind?200:100
  }
  const reader=createGuestSamplingReader(f.module,1)!,result=reader.snapshot()
  f.module.HEAPU8!.fill(0)
  expect(result.samples[0]).toMatchObject({functionName:'hello',filename:'app.js'})
  reader.close()
})

test('does not read fields or decode text again for unchanged records',()=>{
  const f=fixture();f.set([1,2]);const read=vi.fn(f.module._QJS_GuestSamplingRead!),text=vi.fn(f.module._QJS_GuestSamplingText!)
  f.module._QJS_GuestSamplingRead=read;f.module._QJS_GuestSamplingText=text
  const reader=createGuestSamplingReader(f.module,1)!
  expect(reader.snapshot().samples).toHaveLength(2);read.mockClear();text.mockClear()
  expect(reader.snapshot()).toEqual({samples:[],dropped:0})
  expect(read.mock.calls.map(call=>call[2])).toEqual([6,6]);expect(text).not.toHaveBeenCalled()
  reader.close()
})

test('reads only after completed fibers, throttles reads, and flushes at a safe final boundary',()=>{
  let now=0
  const snapshot=vi.fn(()=>({samples:[],dropped:0})),publish=vi.fn()
  const boundaries=createGuestSamplingBoundaries({snapshot,close(){}},publish,()=>now)
  for(const status of [1,3,undefined]){
    boundaries.begin();boundaries.observeStep(status);boundaries.completed();boundaries.flush()
    expect(snapshot).not.toHaveBeenCalled()
  }
  boundaries.begin();boundaries.observeStep(2)
  expect(snapshot).not.toHaveBeenCalled()
  boundaries.completed();expect(snapshot).toHaveBeenCalledTimes(1)
  now=999;boundaries.begin();boundaries.observeStep(2);boundaries.completed()
  expect(snapshot).toHaveBeenCalledTimes(1)
  now=1000;boundaries.begin();boundaries.observeStep(2);boundaries.completed()
  expect(snapshot).toHaveBeenCalledTimes(2)
  boundaries.flush();expect(snapshot).toHaveBeenCalledTimes(3)
})

test('diagnostic read and transport exceptions cannot escape a completed boundary',()=>{
  const snapshot=vi.fn(()=>{throw new Error('broken snapshot')})
  const boundaries=createGuestSamplingBoundaries({snapshot,close(){}},()=>{throw new Error('transport')})
  boundaries.begin();boundaries.observeStep(2)
  expect(()=>boundaries.completed()).not.toThrow()
  const transport=createGuestSamplingBoundaries({snapshot:()=>({samples:[],dropped:0,error:'ABI'}),close(){}},()=>{throw new Error('transport')})
  expect(()=>transport.flush()).not.toThrow()
})

test.each([
  [0,NaN],[1,10],[1,-1],[2,-1],[3,Infinity],[4,96],[5,192],[6,0],[6,1.5],
])('rejects malformed field %s value %s without consuming samples',(field,value)=>{
  const f=fixture();f.set([1]);const reader=createGuestSamplingReader(f.module,1)!
  f.rows[0][field]=value
  expect(reader.snapshot()).toMatchObject({samples:[],dropped:0,error:expect.any(String)})
  f.set([1]);expect(reader.snapshot().samples).toHaveLength(1)
  reader.close()
})

test('accepts the invalid PC sentinel only with the matching flag',()=>{
  const f=fixture();f.set([1]);f.rows[0][1]=-1;f.rows[0][3]=8
  const reader=createGuestSamplingReader(f.module,1)!
  expect(reader.snapshot().samples[0]).toMatchObject({offset:-1,flags:8})
  reader.close()
})

test('rejects oversized rings, invalid pointers, and sequence resets',()=>{
  const f=fixture(),reader=createGuestSamplingReader(f.module,1)!
  f.set(Array.from({length:513},(_,i)=>i+1));expect(reader.snapshot().error).toContain('count')
  f.set([1])
  f.module.HEAPU8=new Uint8Array(102)
  expect(reader.snapshot().error).toContain('bounds')
  f.module.HEAPU8=new Uint8Array(1024)
  expect(reader.snapshot().samples).toHaveLength(1)
  f.set([]);expect(reader.snapshot().error).toContain('backwards')
  reader.close()
})

test.each([0,-1,NaN,1.5,1025])('rejects invalid text pointer %s',pointer=>{
  const f=fixture();f.set([1]);f.module._QJS_GuestSamplingText=()=>pointer
  const reader=createGuestSamplingReader(f.module,1)!
  expect(reader.snapshot().error).toContain('text pointer');reader.close()
})

test('reports initial dropped entries after the ring fills before the first snapshot',()=>{
  const f=fixture();f.set(Array.from({length:512},(_,i)=>i+9))
  const reader=createGuestSamplingReader(f.module,1)!,snapshot=reader.snapshot()
  expect(snapshot.dropped).toBe(8);expect(snapshot.samples).toHaveLength(512);reader.close()
})

test('rejects nonconsecutive sequences',()=>{
  const f=fixture();f.set([1,3]);const reader=createGuestSamplingReader(f.module,1)!
  expect(reader.snapshot().error).toContain('sequence order');reader.close()
})

test('allocation failure and ABI exceptions become diagnostic errors',()=>{
  const f=fixture();f.module._QJS_GuestSamplingReset=vi.fn(()=>-1)
  const reader=createGuestSamplingReader(f.module,1)!
  expect(reader.snapshot().error).toContain('allocation failed');reader.close()
  f.module._QJS_GuestSamplingReset=()=>{throw new Error('ABI failed')}
  const failed=createGuestSamplingReader(f.module,1)!
  expect(failed.snapshot().error).toBe('ABI failed');expect(()=>failed.close()).not.toThrow()
})

test('only the owning reader may reset a runtime and runtime ownership is released',()=>{
  const f=fixture(),first=createGuestSamplingReader(f.module,1)!,duplicate=createGuestSamplingReader(f.module,1)!
  expect(duplicate.snapshot().error).toContain('already has a reader')
  duplicate.close();expect(f.module._QJS_GuestSamplingReset).toHaveBeenCalledTimes(1)
  const other=createGuestSamplingReader(f.module,2)!;other.close();first.close()
  const replacement=createGuestSamplingReader(f.module,1)!
  expect(replacement.snapshot().error).toBeUndefined();replacement.close()
})
