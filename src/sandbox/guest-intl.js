// Process-owned formatting capability. No host object is installed in this realm.
(()=>{
  const invoke=__intlCall
  delete globalThis.__intlCall
  const call=(method,args)=>{
    const result=JSON.parse(invoke(method,JSON.stringify(args)))
    if(result.error){const ErrorType=result.error.name==='RangeError'?RangeError:result.error.name==='TypeError'?TypeError:Error;const error=new ErrorType(result.error.message);if(result.error.code)error.code=result.error.code;throw error}
    return result.value
  }
  const limit=message=>{throw Object.assign(new Error(message),{code:'ERR_RESOURCE_LIMIT'})}
  const string=value=>{if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return String(value)}
  function locales(value){
    if(value===undefined)return []
    if(value===null)throw new TypeError('Cannot convert null to a locale list')
    if(typeof value==='string')value=[value]
    const object=Object(value),length=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(+object.length)||0)),result=[]
    if(length>32)limit('Intl locale list limit exceeded')
    for(let i=0;i<length;i++)if(i in object){
      const locale=object[i]
      if(typeof locale!=='string'&&(typeof locale!=='object'||locale===null))throw new TypeError('Invalid locale')
      const tag=string(locale);if(tag.length>256)limit('Intl locale length limit exceeded');result.push(tag)
    }
    return call('canonical',[result])
  }
  function options(value,supported=false){
    if(value===null)throw new TypeError('Cannot convert null to options')
    const source=value===undefined?{}:Object(value),result=Object.create(null)
    const keys=supported?['localeMatcher']:['localeMatcher','calendar','numberingSystem','hour12','hourCycle','timeZone',
      'weekday','era','year','month','day','dayPeriod','hour','minute','second','fractionalSecondDigits','timeZoneName','formatMatcher','dateStyle','timeStyle']
    for(const key of keys){
      const item=source[key];if(item===undefined)continue
      if(key==='hour12')result[key]=!!item
      else if(key==='fractionalSecondDigits'){
        const number=+item;if(!Number.isFinite(number))throw new RangeError('Invalid fractionalSecondDigits');result[key]=number
      }else{const text=string(item);if(text.length>256)limit('Intl option length limit exceeded');result[key]=text}
    }
    return result
  }
  const states=new WeakMap()
  const state=value=>{const result=states.get(value);if(!result)throw new TypeError('Incompatible DateTimeFormat receiver');return result}
  const time=(value,optional=true)=>{
    const number=value===undefined&&optional?Date.now():+value
    if(!Number.isFinite(number))throw new RangeError('Invalid time value')
    return number
  }
  function DateTimeFormat(localesValue,optionsValue){
    if(!new.target)return new DateTimeFormat(localesValue,optionsValue)
    const id=call('create',[locales(localesValue),options(optionsValue)])
    states.set(this,{id,format:undefined})
  }
  Object.defineProperties(DateTimeFormat.prototype,{
    format:{configurable:true,get(){const value=state(this);return value.format??=(date=>call('format',[value.id,time(date)]))}},
    formatToParts:{configurable:true,writable:true,value:function(date){return call('parts',[state(this).id,time(date)])}},
    formatRange:{configurable:true,writable:true,value:function(start,end){if(start===undefined||end===undefined)throw new TypeError('Range endpoints are required');return call('range',[state(this).id,time(start,false),time(end,false)])}},
    formatRangeToParts:{configurable:true,writable:true,value:function(start,end){if(start===undefined||end===undefined)throw new TypeError('Range endpoints are required');return call('rangeParts',[state(this).id,time(start,false),time(end,false)])}},
    resolvedOptions:{configurable:true,writable:true,value:function(){return call('resolved',[state(this).id])}},
    [Symbol.toStringTag]:{configurable:true,value:'Intl.DateTimeFormat'},
  })
  Object.defineProperty(DateTimeFormat,'supportedLocalesOf',{configurable:true,writable:true,value:function(value,matching){return call('supported',[locales(value),options(matching,true)])}})
  const intl={}
  const numbers=new WeakMap()
  const numberState=value=>{const result=numbers.get(value);if(!result)throw new TypeError('Incompatible NumberFormat receiver');return result}
  const numberValue=value=>{
    if(value!==null&&(typeof value==='object'||typeof value==='function')){
      const exotic=value[Symbol.toPrimitive];let primitive=value;
      if(exotic!==undefined&&exotic!==null){if(typeof exotic!=='function')throw new TypeError('Invalid primitive conversion');primitive=exotic.call(value,'number')}
      else{for(const name of ['valueOf','toString']){const method=value[name];if(typeof method==='function'){primitive=method.call(value);if(primitive===null||!['object','function'].includes(typeof primitive))break}}}
      if(primitive!==null&&['object','function'].includes(typeof primitive))throw new TypeError('Cannot convert object to primitive')
      value=primitive
    }
    const kind=typeof value==='bigint'?'bigint':typeof value==='string'?'string':'number'
    const text=kind==='number'?(Object.is(+value,-0)?'-0':String(+value)):String(value)
    if(text.length>4096)limit('Intl number length limit exceeded')
    return {kind,value:text}
  }
  function NumberFormat(locale,settings){
    if(!new.target)return new NumberFormat(locale,settings)
    const tags=locales(locale),opts=Object.create(null)
    if(settings===null)throw new TypeError('Cannot convert null to options')
    const source=settings===undefined?{}:Object(settings)
    const digits=['minimumIntegerDigits','minimumFractionDigits','maximumFractionDigits','minimumSignificantDigits','maximumSignificantDigits','roundingIncrement']
    for(const key of ['localeMatcher','numberingSystem','style','currency','currencyDisplay','currencySign','unit','unitDisplay','notation',...digits,'roundingMode','roundingPriority','trailingZeroDisplay','compactDisplay','useGrouping','signDisplay']){
      const item=source[key];if(item===undefined)continue
      if(digits.includes(key)){opts[key]=+item;if(!Number.isFinite(opts[key]))throw new RangeError('Invalid digit option')}
      else if(key==='useGrouping'&&typeof item==='boolean')opts[key]=item
      else{const text=string(item);if(text.length>256)limit('Intl option length limit exceeded');opts[key]=text}
    }
    numbers.set(this,{id:call('number:create',[tags,opts]),format:undefined})
  }
  Object.defineProperties(NumberFormat.prototype,{
    format:{configurable:true,get(){const state=numberState(this);return state.format??=(value=>call('number:format',[state.id,numberValue(value)]))}},
    formatToParts:{configurable:true,writable:true,value:function(value){return call('number:parts',[numberState(this).id,numberValue(value)])}},
    formatRange:{configurable:true,writable:true,value:function(start,end){if(start===undefined||end===undefined)throw new TypeError('Range endpoints required');return call('number:range',[numberState(this).id,numberValue(start),numberValue(end)])}},
    formatRangeToParts:{configurable:true,writable:true,value:function(start,end){if(start===undefined||end===undefined)throw new TypeError('Range endpoints required');return call('number:rangeParts',[numberState(this).id,numberValue(start),numberValue(end)])}},
    resolvedOptions:{configurable:true,writable:true,value:function(){return call('number:resolved',[numberState(this).id])}},
    [Symbol.toStringTag]:{configurable:true,value:'Intl.NumberFormat'},
  })
  Object.defineProperty(NumberFormat,'supportedLocalesOf',{configurable:true,writable:true,value:function(value,matching){return call('number:supported',[locales(value),options(matching,true)])}})
  const lists=new WeakMap()
  const listState=value=>{const result=lists.get(value);if(!result)throw new TypeError('Incompatible ListFormat receiver');return result}
  const listOptions=value=>{
    if(value===null)throw new TypeError('Cannot convert null to options')
    const source=value===undefined?{}:Object(value),result=Object.create(null)
    for(const key of ['localeMatcher','type','style']){const item=source[key];if(item!==undefined){const text=string(item);if(text.length>256)limit('Intl option length limit exceeded');result[key]=text}}
    return result
  }
  const listValues=value=>{
    if(value===undefined)return []
    if(value===null||typeof value[Symbol.iterator]!=='function')throw new TypeError('List value is not iterable')
    const result=[];let length=0
    for(const item of value){if(typeof item!=='string')throw new TypeError('List items must be strings');length+=item.length;if(result.length>=4096||length>1024*1024)limit('Intl list value limit exceeded');result.push(item)}
    return result
  }
  function ListFormat(locale,settings){
    if(!new.target)return new ListFormat(locale,settings)
    lists.set(this,{id:call('list:create',[locales(locale),listOptions(settings)])})
  }
  Object.defineProperties(ListFormat.prototype,{
    format:{configurable:true,writable:true,value:function(value){return call('list:format',[listState(this).id,listValues(value)])}},
    formatToParts:{configurable:true,writable:true,value:function(value){return call('list:parts',[listState(this).id,listValues(value)])}},
    resolvedOptions:{configurable:true,writable:true,value:function(){return call('list:resolved',[listState(this).id])}},
    [Symbol.toStringTag]:{configurable:true,value:'Intl.ListFormat'},
  })
  Object.defineProperty(ListFormat,'supportedLocalesOf',{configurable:true,writable:true,value:function(value,matching){return call('list:supported',[locales(value),listOptions(matching)])}})
  Object.defineProperties(intl,{
    DateTimeFormat:{configurable:true,writable:true,value:DateTimeFormat},
    NumberFormat:{configurable:true,writable:true,value:NumberFormat},
    ListFormat:{configurable:true,writable:true,value:ListFormat},
    getCanonicalLocales:{configurable:true,writable:true,value:locales},
    [Symbol.toStringTag]:{configurable:true,value:'Intl'},
  })
  Object.defineProperty(globalThis,'Intl',{configurable:true,writable:true,value:intl})
})()
