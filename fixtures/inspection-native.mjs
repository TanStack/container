export const setup = `
globalThis.run = function run(){
  let traps=0;
  const trap=()=>{traps++;throw Error('trap')};
  const target={answer:42},handler={get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap};
  const inner=new Proxy(target,handler),outer=new Proxy(inner,handler);
  const live=inspection.getProxyDetails(inner,true);
  const revoked=Proxy.revocable(target,handler);revoked.revoke();
  const pending=new Promise(()=>{}),fulfilled=Promise.resolve(target),rejected=Promise.reject(target);rejected.catch(()=>{});
  const p=inspection.getPromiseDetails(pending),f=inspection.getPromiseDetails(fulfilled),r=inspection.getPromiseDetails(rejected);
  const fake={get then(){traps++;throw Error('then getter')}};
  globalThis.retained=[live, f, r];
  const preview=inspection.previewEntries;
  const map=new Map([['a',1],['b',2]]),set=new Set([3,4]);
  const objects=[map,set,map.keys(),map.values(),map.entries(),set.values(),set.entries(),[],[1,2].values(),{},new WeakMap([[target,7]]),new WeakSet([target])];
  const previews=objects.map(value=>[preview(value),preview(value,true)]);
  const iterator=map.entries();const first=iterator.next();map.delete('a');map.delete('b');map.set('c',3);
  const before=preview(iterator,true),next=iterator.next(),last=preview(iterator,true),done=iterator.next();map.set('d',4);
  const exhausted=preview(iterator,true);
  const guarded=map.keys();Object.defineProperty(guarded,'next',{get:trap});
  const guardedPreview=preview(guarded,true);
  const objectKey={kept:123},objectValue={kept:456};
  globalThis.retainedEntries=preview(new Map([[objectKey,objectValue]]).entries());
  const weakKey={weakKey:123},weakValue={weakValue:456};
  globalThis.retainedWeakEntries=preview(new WeakMap([[weakKey,weakValue]]));
  return JSON.stringify([
    inspection.getProxyDetails({})===undefined,
    inspection.getProxyDetails(42)===undefined,
    live[0]===target,live[1]===handler,
    inspection.getProxyDetails(inner,false)===target,
    inspection.getProxyDetails(inner)[0]===target,
    inspection.getProxyDetails(outer,false)===inner,
    inspection.getProxyDetails(outer,true)[0]===inner,
    inspection.getProxyDetails(revoked.proxy,false),
    inspection.getProxyDetails(revoked.proxy,true),
    p,[f[0],f[1]===target],[r[0],r[1]===target],
    inspection.getPromiseDetails(fake)===undefined,
    inspection.getPromiseDetails(inner)===undefined,
    inspection.getPromiseDetails(null)===undefined,traps,
    previews,[first,before,next,last,done,exhausted],guardedPreview,
    preview(inner)===undefined,inspectTypes(),inspectProperties(),inspectConstructors()
  ]);
};
globalThis.checkRetained=function(){
  if(retained[0][0].answer!==42 || retained[1][1]!==retained[0][0] || retained[2][1]!==retained[0][0])throw Error('lost reference');
  if(retainedEntries[0].kept!==123 || retainedEntries[1].kept!==456)throw Error('lost entries');
  if(retainedWeakEntries[0].weakKey!==123 || retainedWeakEntries[1].weakValue!==456)throw Error('lost weak entries');
  if(retainedPropertyKeys[0].description!=='only snapshot')throw Error('lost property symbol');
  if(inspection.getConstructorName(retainedConstructorInstance)!=='Retained')throw Error('lost constructor name');
};
`;
