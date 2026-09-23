export const propertySetup = `
globalThis.inspectProperties=function(){
  let getters=0;
  const getter=()=>{getters++;throw Error('value getter executed')};
  const symbol=Symbol('visible'),hiddenSymbol=Symbol('hidden');
  const decorate=value=>{
    Object.defineProperties(value,{
      getter:{get:getter,enumerable:true,configurable:true},
      setter:{set(v){},enumerable:true,configurable:true},
      both:{get:getter,set(v){},enumerable:true},
      hidden:{value:1},writable:{value:2,writable:true},
      normal:{value:3,writable:true,enumerable:true,configurable:true},
      [symbol]:{value:4,enumerable:true,writable:true,configurable:true},
      [hiddenSymbol]:{value:5},
    });return value;
  };
  const object=decorate({'0':0,'1':1,'01':2,'-0':3,'4294967294':4,'4294967295':5,'9007199254740991':6});
  const array=decorate([1,,3]);array['4294967294']=7;array['4294967295']=8;
  const typed=decorate(new Uint8Array([1,2,3]));
  const string=decorate(Object('text'));
  const filters=Array.from({length:32},(_,i)=>i);
  const results=[object,array,typed,string].map(value=>filters.map(filter=>inspection.getOwnNonIndexProperties(value,filter).map(key=>typeof key==='symbol'?['symbol',key.description]:key)));
  const keys=inspection.getOwnNonIndexProperties(object,0);
  const retainedSymbol=Symbol('only snapshot');
  globalThis.retainedPropertyKeys=inspection.getOwnNonIndexProperties({[retainedSymbol]:1},0);
  return {results,symbolIdentity:keys.includes(symbol)&&keys.includes(hiddenSymbol),getters};
};
`;
