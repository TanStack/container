import {test,expect} from '@playwright/test'
const source=`(()=>{
  const values=[];
  for(const Type of [Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,BigInt64Array,BigUint64Array]){
    const array=new Type(new SharedArrayBuffer(16)),big=Type===BigInt64Array||Type===BigUint64Array,v=n=>big?BigInt(n):n;
    values.push([Type.name,Atomics.store(array,0,v(7)),Atomics.add(array,0,v(2)),Atomics.compareExchange(array,0,v(9),v(42)),Atomics.load(array,0)].map(String));
  }
  values.push(['notify',Atomics.notify(new Int32Array(new SharedArrayBuffer(4)),0)]);
  return JSON.stringify(values)
})()`
test('native guest atomics work without browser shared memory',async({page},info)=>{
  const expected=eval(source)
  await page.goto('/sandbox.html')
  const result=await page.evaluate(async source=>{
    const url='/src/feasibility/native-atomics.ts'
    const {probeNativeAtomics}=await import(/* @vite-ignore */url)
    return probeNativeAtomics(source)
  },source)
  await info.attach('atomics.json',{body:JSON.stringify(result),contentType:'application/json'})
  expect(result.crossOriginIsolated).toBe(false)
  expect(result.hostSharedArrayBuffer).toBe('undefined')
  expect(result.value).toBe(expected)
})
