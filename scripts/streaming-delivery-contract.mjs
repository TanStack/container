import assert from 'node:assert/strict'

/** A complete result alone does not prove incremental delivery. */
export async function verifyStreamingDelivery({click,read,poll,label}){
  const started=performance.now()
  await click()
  let first
  await poll(async()=>{
    const text=(await read())??''
    const count=text.match(/Number #\d+:/g)?.length??0
    if(count>0&&count<10){first={count,elapsedMs:performance.now()-started};return true}
    return false
  },'Expected a visible partial streaming result before all ten numbers')
  await poll(async()=>(((await read())??'').match(/Number #\d+:/g)?.length??0)===10,'Expected all ten streamed numbers')
  assert.ok(first&&first.count<10)
  const evidence={label,first,completedMs:performance.now()-started}
  console.log('STREAMING_DELIVERY '+JSON.stringify(evidence))
  return evidence
}
