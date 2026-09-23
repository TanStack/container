const assert=(condition,message)=>{if(!condition)throw Error(message)}
const bytes=text=>new TextEncoder().encode(text)
const text=value=>new TextDecoder().decode(value)
const denied=(call,code='EBADF')=>{try{call()}catch(error){assert(error.code===code,`Expected ${code}, received ${error.code}: ${error}`);return}throw Error('Operation unexpectedly permitted')}

export function handshake(backend,pairs,fragment=13){
  const ready=new Set()
  for(let step=0;step<10000;step++){
    for(const pair of pairs)for(const endpoint of pair){
      if(!ready.has(endpoint.id)&&backend.step(endpoint.owner,endpoint.id)===0)ready.add(endpoint.id)
    }
    for(const pair of pairs)for(let i=0;i<2;i++){
      const from=pair[i],to=pair[1-i],output=backend.drain(from.owner,from.id)
      for(let offset=0;offset<output.length;offset+=fragment){
        const chunk=output.subarray(offset,offset+fragment)
        assert(backend.feed(to.owner,to.id,chunk)===chunk.length,'Encrypted input was not accepted')
      }
    }
    if(ready.size===pairs.length*2)return step+1
  }
  throw Error('TLS handshake did not finish')
}
export function transfer(backend,from,to,message){
  const payload=bytes(message)
  assert(backend.write(from.owner,from.id,payload)===payload.length,'TLS plaintext write failed')
  const encrypted=backend.drain(from.owner,from.id)
  assert(backend.feed(to.owner,to.id,encrypted)===encrypted.length,'TLS record input failed')
  let result=''
  for(let count=0;count<100;count++){
    const read=backend.read(to.owner,to.id)
    if(read.code>0)result+=text(read.bytes)
    else if(read.code===-0x6900||read.code===-0x6880)break
    else throw Error('Unexpected TLS read: '+read.code)
  }
  assert(result===message,'TLS plaintext mismatch')
}
export async function ownedWorkflow(backend,identity,version){
  const settings={minVersion:version,maxVersion:version}
  const server={...settings,server:true,cert:identity.cert,key:identity.key}
  const client={...settings,servername:'localhost',ca:identity.ca}
  const ownerSettings={maxBytes:2*1024*1024,maxConnections:4}
  await backend.createOwner(1,ownerSettings);await backend.createOwner(2,ownerSettings)
  const pairs=[
    [{owner:1,id:backend.open(1,server)},{owner:2,id:backend.open(2,client)}],
    [{owner:2,id:backend.open(2,server)},{owner:1,id:backend.open(1,client)}],
  ]
  let denials=0
  for(const pair of pairs)for(const endpoint of pair){
    const wrong=endpoint.owner===1?2:1
    for(const method of ['step','drain','read','info','eof','close','destroy']){denied(()=>backend[method](wrong,endpoint.id));denials++}
    for(const method of ['feed','write']){denied(()=>backend[method](wrong,endpoint.id,bytes('forged')));denials++}
  }
  const steps=handshake(backend,pairs)
  for(const [index,pair] of pairs.entries()){
    transfer(backend,pair[1],pair[0],'request '+index)
    transfer(backend,pair[0],pair[1],'response '+index)
    assert(backend.info(pair[1].owner,pair[1].id).verifyFlags===0,'Peer was not authorized')
    assert(backend.info(pair[1].owner,pair[1].id).protocol===`TLSv1.${version-10}`,'Wrong TLS version')
  }
  const stats=[backend.stats(1),backend.stats(2)]
  assert(stats.every(value=>value.connections===2&&value.allocated<=value.maxBytes),'Owner accounting mismatch')
  await backend.closeOwner(1)
  for(const pair of pairs)for(const endpoint of pair)if(endpoint.owner===1)denied(()=>backend.info(1,endpoint.id))
  assert(backend.stats(2).connections===2,'Closing one owner changed another owner')
  // The surviving owner can still perform fresh crypto, with its original
  // connections alive, after the other instance and its PSA state were freed.
  const survivors=[[{owner:2,id:backend.open(2,server)},{owner:2,id:backend.open(2,client)}]]
  handshake(backend,survivors,1);transfer(backend,survivors[0][1],survivors[0][0],'survived')
  denied(()=>backend.open(2,client),'ERR_TLS_BACKEND')
  const stale=survivors[0][0].id
  backend.destroy(2,stale);denied(()=>backend.destroy(2,stale))
  const replacement=backend.open(2,server)
  assert(replacement!==stale,'Destroyed handle was reused')
  denied(()=>backend.info(2,stale))
  await backend.closeOwner(2)
  await backend.createOwner(1,ownerSettings)
  for(const pair of pairs)for(const endpoint of pair)denied(()=>backend.info(1,endpoint.id))
  await backend.closeOwner(1)
  return {version,steps,denials,stats,survivor:true,staleHandlesRejected:true}
}
