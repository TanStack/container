export function makePayload(){
  const buffer=new ArrayBuffer(16),all=new Uint8Array(buffer);all.set([0,1,2,3,4,5,6,7])
  const regexp=/hello/gi;regexp.lastIndex=3
  const value={
    map:new Map([['answer',42]]),set:new Set([1,'two']),date:new Date('2020-01-02T03:04:05.000Z'),regexp,big:9007199254740993n,
    buffer,bytes:new Uint8Array(buffer,1,5),words:new Uint16Array(buffer,2,2),view:new DataView(buffer,4,4),
    errors:[new Error('base',{cause:7}),new EvalError('eval'),new RangeError('range'),new ReferenceError('reference'),new SyntaxError('syntax'),new TypeError('type',{cause:{answer:42}}),new URIError('uri'),new AggregateError([new Error('nested')],'aggregate',{cause:9})],
  }
  value.self=value;value.map.set('self',value);value.set.add(value)
  return value
}
export function summarize(value){
  return {
    map:[...value.map.entries()].map(([key,item])=>[key,item===value?'self':item]),set:[...value.set].map(item=>item===value?'self':item),
    date:{type:value.date.constructor.name,value:value.date.toISOString()},regexp:{type:value.regexp.constructor.name,source:value.regexp.source,flags:value.regexp.flags,lastIndex:value.regexp.lastIndex},big:String(value.big),
    buffer:[...new Uint8Array(value.buffer)],bytes:[...value.bytes],words:[...value.words],view:[...new Uint8Array(value.view.buffer,value.view.byteOffset,value.view.byteLength)],
    aliases:[value.bytes.buffer===value.buffer,value.words.buffer===value.buffer,value.view.buffer===value.buffer],cycle:value.self===value,
    errors:value.errors.map(error=>({type:error.constructor.name,name:error.name,message:error.message,cause:error.cause??null})),
  }
}
