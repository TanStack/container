// Sources execute unchanged in Node and in each guest engine.
export const inspectionCases = {
  'private inspection helpers are not guest globals or public utilities': `
    import * as util from 'node:util';
    const names=['getProxyDetails','getPromiseDetails','previewEntries','getOwnNonIndexProperties','getConstructorName'];
    console.log(JSON.stringify([names.map(name=>typeof util[name]),names.map(name=>typeof globalThis[name]),['inspection','__nativeInspection','QJS_NewInspection','QTS_InitializeInspection'].map(name=>name in globalThis)]));`,
  'nested collections and primitive values': `
    import {inspect} from 'node:util';
    console.log(JSON.stringify(inspect({map:new Map([['a',{n:123n}]]),set:new Set([Symbol('x'),-0]),list:[undefined,NaN,Infinity]})));`,
  'symbol custom inspection receives depth options and recursive inspector': `
    import {inspect} from 'node:util';
    const calls=[];const value={
      [Symbol.for('nodejs.util.inspect.custom')](depth,options,recursive){
        calls.push([depth,options.colors,options.customFlag,typeof recursive]);
        return {result:recursive(123n,{colors:false})};
      }
    };
    console.log(JSON.stringify([inspect({value},{depth:3,customFlag:'kept'}),calls,inspect(value,{customInspect:false})]));`,
  'legacy inspect method is ordinary data not an inspection hook': `
    import {inspect} from 'node:util';let called=0;
    const value={inspect(){called++;return 'legacy hook'}};
    console.log(JSON.stringify([inspect(value),called]));`,
  'cycles shared references and collection back references': `
    import {inspect} from 'node:util';const shared={x:1};const root={a:shared,b:shared};root.self=root;
    const map=new Map();map.set('self',map);const set=new Set();set.add(set);
    console.log(JSON.stringify([root,map,set].map(value=>inspect(value))));`,
  'inspection options depth sorting truncation colors and separators': `
    import {inspect} from 'node:util';
    const checks=[
      [{z:1,a:{b:{c:2}}},{depth:1,sorted:true}],
      [[1,2,3,4],{maxArrayLength:2}],
      ['abcdefgh',{maxStringLength:3}],
      [1234567.123456,{numericSeparator:true}],
      [1234567890n,{numericSeparator:true,colors:true}],
      [new Map([['z',2],['a',1]]),{sorted:true}],
    ];console.log(JSON.stringify(checks.map(([value,options])=>inspect(value,options))));`,
  'getters are not evaluated unless requested': `
    import {inspect} from 'node:util';let calls=0;
    const value={get result(){calls++;return 123n}};
    const normal=inspect(value);const before=calls;const enabled=inspect(value,{getters:true});
    console.log(JSON.stringify([normal,before,enabled,calls]));`,
  'proxy inspection does not execute traps': `
    import {inspect} from 'node:util';let traps=0;
    const trap=()=>{traps++;throw Error('proxy trap executed')};
    const value=new Proxy({answer:42},{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,getPrototypeOf:trap});
    let result;try{result=inspect(value)}catch(error){result={error:error.message}}
    console.log(JSON.stringify([result,traps]));`,
  'revoked proxies are printable': `
    import {inspect} from 'node:util';const proxy=Proxy.revocable({},{});proxy.revoke();
    let result;try{result=inspect(proxy.proxy)}catch(error){result={error:error.name}}
    console.log(JSON.stringify(result));`,
  'promise state and result inspection': `
    import {inspect} from 'node:util';const pending=new Promise(()=>{}),resolved=Promise.resolve({answer:42}),rejected=Promise.reject('no');rejected.catch(()=>{});
    console.log(JSON.stringify([pending,resolved,rejected].map(value=>inspect(value))));`,
  'map iterator inspection does not advance the iterator': `
    import {inspect} from 'node:util';const iterator=new Map([['a',1],['b',2]]).entries();
    const before=inspect(iterator),first=iterator.next(),after=inspect(iterator);
    console.log(JSON.stringify([before,first,after,iterator.next()]));`,
  'formatWithOptions placeholder and remaining argument behavior': `
    import {formatWithOptions as format} from 'node:util';
    console.log(JSON.stringify([
      format({numericSeparator:true},'%d %i %f',1234567,1234567,1234567.123456),
      format({},'%O %s %o',new Set([1,2]),new Map([['a',1]]),{a:1}),
      format({},'%% %c %j','style',{a:1}),
      format({},'extra',undefined,123n,Symbol('x')),
    ]));`,
  'array buffers data views and typed arrays': `
    import {inspect} from 'node:util';
    const buffer=new Uint8Array([0,1,15,16,127,255]).buffer;
    const limits=[0,1,1.5,3,-1,-0.5,NaN,Infinity].map(maxArrayLength=>{try{return {value:inspect(buffer,{maxArrayLength})}}catch(error){return {name:error.name,message:error.message}}});
    console.log(JSON.stringify([[buffer,new DataView(buffer,1,3),new Uint8Array(buffer),new BigInt64Array([1n,-2n])].map(value=>inspect(value)),limits]));`,
  'hidden properties sparse arrays and boxed primitives': `
    import {inspect} from 'node:util';const array=[1,,3];array.extra=4;
    Object.defineProperty(array,'hidden',{value:5});
    console.log(JSON.stringify([inspect(array,{showHidden:true}),...['x',42,true,123n,Symbol('x')].map(value=>inspect(Object(value)))]));`,
  'invalid formatting options report Node error codes and messages': `
    import {inspect,formatWithOptions,stripVTControlCharacters} from 'node:util';
    const output=[];for(const value of [null,1,true,'bad',()=>{},[],Object.create(null)]){
      for(const operation of [()=>formatWithOptions(value,'x'),()=>{inspect.defaultOptions=value;return 'accepted'},()=>stripVTControlCharacters(value)]){
        try{output.push({value:operation()})}catch(error){output.push({name:error.name,code:error.code,message:error.message})}
      }
    }console.log(JSON.stringify(output));`,
  'errors with deterministic stacks and causes': `
    import {inspect} from 'node:util';const cause=new Error('root');cause.stack='Error: root';
    const error=new TypeError('outer',{cause});error.stack='TypeError: outer';error.code='E_TEST';
    console.log(JSON.stringify(inspect(error)));`,
  'proxy display and hidden weak collection entries': `
    import {inspect} from 'node:util';const target={answer:42},handler={};
    const weakMap=new WeakMap([[target,123n]]),weakSet=new WeakSet([target]);
    console.log(JSON.stringify([inspect(new Proxy(target,handler),{showProxy:true}),inspect(weakMap,{showHidden:true}),inspect(weakSet,{showHidden:true})]));`,
  'unicode escapes and narrow multiline formatting': `
    import {inspect} from 'node:util';
    console.log(JSON.stringify([inspect(['café','漢字','😀','e\\u0301'],{breakLength:16}),inspect('\\u0000\\u001b\\ud800'),inspect({a:'a\\nb',b:'x'.repeat(30)},{breakLength:20})]));`,
};
