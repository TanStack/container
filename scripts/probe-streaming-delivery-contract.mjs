import assert from 'node:assert/strict'
import {verifyStreamingDelivery} from './streaming-delivery-contract.mjs'
const text=count=>Array.from({length:count},(_,index)=>`Number #${index+1}: 1`).join('\n')
const poll=async(read,message)=>{
  for(let attempt=0;attempt<4;attempt++)if(await read())return
  throw Error(message)
}
let count=0
const result=await verifyStreamingDelivery({label:'incremental fixture',click:async()=>{},read:async()=>text(++count===1?1:10),poll})
assert.equal(result.first.count,1)
await assert.rejects(verifyStreamingDelivery({label:'buffered fixture',click:async()=>{},read:async()=>text(10),poll}),/visible partial/)
console.log('Streaming contract accepts incremental results and rejects fully buffered results')
