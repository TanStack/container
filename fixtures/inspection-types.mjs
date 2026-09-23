export const typeSetup = `
globalThis.inspectTypes=function(){
  const types=inspection.types,names=Object.getOwnPropertyNames(types).sort();let traps=0;
  const trap=()=>{traps++;throw Error('type predicate ran user code')};
  const values={
    undefined:undefined,null:null,number:123,string:'text',boolean:true,symbol:Symbol('x'),bigint:123n,
    object:{},array:[],numberObject:Object(123),stringObject:Object('text'),booleanObject:Object(true),symbolObject:Object(Symbol('x')),bigintObject:Object(123n),
    date:new Date(0),regexp:/test/,error:new Error('test'),aggregate:new AggregateError([]),
    map:new Map(),set:new Set(),weakMap:new WeakMap(),weakSet:new WeakSet(),mapIterator:new Map().keys(),setIterator:new Set().entries(),
    promise:Promise.resolve(1),fn:function(){},asyncFn:async function(){},generatorFn:function*(){},asyncGeneratorFn:async function*(){},
    generator:(function*(){})(),asyncGenerator:(async function*(){})(),
    args:(function(){return arguments})(1),mappedArgs:Function('return arguments')(1),
    buffer:new ArrayBuffer(8),shared:new SharedArrayBuffer(8),view:new DataView(new ArrayBuffer(8)),
    namespace:moduleNamespace,forgedMap:Object.create(Map.prototype),forgedError:Object.create(Error.prototype),
    fake:{[Symbol.toStringTag]:'Promise'},trapped:new Proxy({}, {get:trap,getPrototypeOf:trap,ownKeys:trap}),
  };
  for(const name of ['Uint8ClampedArray','Int8Array','Uint8Array','Int16Array','Uint16Array','Int32Array','Uint32Array','BigInt64Array','BigUint64Array','Float16Array','Float32Array','Float64Array'])values[name]=new globalThis[name](2);
  values.mapSubclass=new (class extends Map {})();values.errorSubclass=new (class extends Error {})();
  values.boundAsync=values.asyncFn.bind(null);values.boundGenerator=values.generatorFn.bind(null);
  values.proxyMap=new Proxy(values.map,{get:trap,getPrototypeOf:trap});
  const revoked=Proxy.revocable(values.map,{});revoked.revoke();values.revoked=revoked.proxy;
  const secret=new Map();Object.defineProperty(secret,Symbol.toStringTag,{get:trap});Object.setPrototypeOf(secret,null);values.hiddenMap=secret;
  const checks=Object.entries(values).map(([label,value])=>[label,names.filter(name=>types[name](value))]);
  checks.push(['no argument',names.filter(name=>types[name]())],['traps',traps]);
  return {names,checks};
};
`;
