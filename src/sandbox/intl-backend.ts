const stringOptions=new Set(['localeMatcher','calendar','numberingSystem','hourCycle','timeZone',
  'weekday','era','year','month','day','dayPeriod','hour','minute','second','timeZoneName',
  'formatMatcher','dateStyle','timeStyle'])
const resource=(message:string)=>Object.assign(new Error(message),{code:'ERR_RESOURCE_LIMIT'})
const numberStrings=new Set(['localeMatcher','numberingSystem','style','currency','currencyDisplay','currencySign','unit','unitDisplay','notation','compactDisplay','signDisplay','roundingMode','roundingPriority','trailingZeroDisplay'])
const numberDigits=new Set(['minimumIntegerDigits','minimumFractionDigits','maximumFractionDigits','minimumSignificantDigits','maximumSignificantDigits','roundingIncrement'])
const listStrings=new Set(['localeMatcher','type','style'])

// One instance belongs to one process. Only JSON values cross the guest boundary.
// Browser Intl objects, bound functions and prototypes never leave this owner.
export class IntlDateTimeBackend {
  #formatters=new Map<number,Intl.DateTimeFormat>()
  #numbers=new Map<number,Intl.NumberFormat>()
  #lists=new Map<number,Intl.ListFormat>()
  #next=1
  #closed=false
  constructor(readonly maxFormatters=64){
    if(!Number.isSafeInteger(maxFormatters)||maxFormatters<1||maxFormatters>1024)throw new Error('Invalid Intl formatter limit')
  }
  get size(){return this.#formatters.size+this.#numbers.size+this.#lists.size}
  close(){this.#closed=true;this.#formatters.clear();this.#numbers.clear();this.#lists.clear()}
  #listOptions(value:unknown):Intl.ListFormatOptions{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid list options')
    const result=Object.create(null)
    for(const [key,item] of Object.entries(value)){
      if(!listStrings.has(key)||typeof item!=='string'||item.length>256)throw new TypeError('Invalid list option')
      result[key]=item
    }
    return result
  }
  #list(value:unknown):string[]{
    if(!Array.isArray(value)||value.length>4096)throw resource('Intl list value limit exceeded')
    let length=0
    for(const item of value){if(typeof item!=='string')throw new TypeError('Invalid list value');length+=item.length;if(length>1024*1024)throw resource('Intl list text limit exceeded')}
    return value
  }
  #numberOptions(value:unknown):Intl.NumberFormatOptions{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid number options')
    const result=Object.create(null)
    for(const [key,item] of Object.entries(value)){
      if(numberStrings.has(key)){if(typeof item!=='string'||item.length>256)throw new TypeError('Invalid number option')}
      else if(numberDigits.has(key)){if(typeof item!=='number'||!Number.isFinite(item))throw new RangeError('Invalid digit option')}
      else if(key==='useGrouping'){if(typeof item!=='boolean'&&(typeof item!=='string'||item.length>256))throw new TypeError('Invalid grouping option')}
      else throw new TypeError('Unknown number option')
      result[key]=item
    }
    return result
  }
  #number(value:unknown):number|bigint|string{
    const item=value as {kind:string;value:string}
    if(!item||typeof item.value!=='string'||item.value.length>4096)throw new TypeError('Invalid number value')
    if(item.kind==='number')return Number(item.value)
    if(item.kind==='bigint')return BigInt(item.value)
    if(item.kind==='string')return item.value
    throw new TypeError('Invalid number kind')
  }
  #locales(value:unknown):string[]{
    if(!Array.isArray(value)||value.length>32)throw resource('Intl locale list limit exceeded')
    if(value.some(locale=>typeof locale!=='string'||locale.length>256))throw new TypeError('Invalid Intl locale list')
    return value
  }
  #options(value:unknown,supported=false):Intl.DateTimeFormatOptions {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid Intl options')
    const options=Object.create(null) as Record<string,unknown>
    for(const [key,item] of Object.entries(value)){
      if(supported&&key!=='localeMatcher')throw new TypeError('Invalid locale matching option')
      if(stringOptions.has(key)){
        if(typeof item!=='string'||item.length>256)throw new TypeError('Invalid Intl string option')
      }else if(key==='hour12'){
        if(typeof item!=='boolean')throw new TypeError('Invalid hour12 option')
      }else if(key==='fractionalSecondDigits'){
        if(typeof item!=='number'||!Number.isFinite(item))throw new RangeError('Invalid fractionalSecondDigits')
      }else throw new TypeError('Unknown Intl option')
      options[key]=item
    }
    return options
  }
  #time(value:unknown):number {
    if(typeof value!=='number'||!Number.isFinite(value))throw new RangeError('Invalid time value')
    return value
  }
  call(method:string,args:unknown[]):unknown {
    if(this.#closed)throw new Error('Intl owner is closed')
    if(!Array.isArray(args)||args.length>3)throw new TypeError('Invalid Intl request')
    if(method.startsWith('list:')){
      const action=method.slice(5)
      if(action==='supported')return Intl.ListFormat.supportedLocalesOf(this.#locales(args[0]),this.#listOptions(args[1]))
      if(action==='create'){
        if(this.size>=this.maxFormatters)throw resource('Intl formatter limit exceeded')
        const formatter=new Intl.ListFormat(this.#locales(args[0]),this.#listOptions(args[1]))
        const id=this.#next++;this.#lists.set(id,formatter);return id
      }
      const formatter=this.#lists.get(args[0] as number)
      if(!formatter)throw new TypeError('Invalid list formatter')
      if(action==='resolved')return formatter.resolvedOptions()
      if(action==='format')return formatter.format(this.#list(args[1]))
      if(action==='parts')return formatter.formatToParts(this.#list(args[1]))
      throw new TypeError('Unknown list operation')
    }
    if(method.startsWith('number:')){
      const action=method.slice(7)
      if(action==='supported')return Intl.NumberFormat.supportedLocalesOf(this.#locales(args[0]),this.#options(args[1],true))
      if(action==='create'){
        if(this.size>=this.maxFormatters)throw resource('Intl formatter limit exceeded')
        const formatter=new Intl.NumberFormat(this.#locales(args[0]),this.#numberOptions(args[1]))
        const id=this.#next++;this.#numbers.set(id,formatter);return id
      }
      const formatter=this.#numbers.get(args[0] as number)
      if(!formatter)throw new TypeError('Invalid number formatter')
      if(action==='resolved')return formatter.resolvedOptions()
      const operations={format:'format',parts:'formatToParts',range:'formatRange',rangeParts:'formatRangeToParts'} as const
      const name=operations[action as keyof typeof operations]
      if(!name)throw new TypeError('Unknown number operation')
      const fn=Reflect.get(formatter,name)
      return Reflect.apply(fn,formatter,action==='range'||action==='rangeParts'?[this.#number(args[1]),this.#number(args[2])]:[this.#number(args[1])])
    }
    if(method==='canonical')return Intl.getCanonicalLocales(this.#locales(args[0]))
    if(method==='supported')return Intl.DateTimeFormat.supportedLocalesOf(this.#locales(args[0]),this.#options(args[1],true))
    if(method==='create'){
      if(this.size>=this.maxFormatters)throw resource('Intl formatter limit exceeded')
      const formatter=new Intl.DateTimeFormat(this.#locales(args[0]),this.#options(args[1]))
      const id=this.#next++;this.#formatters.set(id,formatter);return id
    }
    if(!['format','parts','range','rangeParts','resolved'].includes(method))throw new TypeError('Unknown Intl operation')
    const id=args[0]
    if(typeof id!=='number'||!Number.isSafeInteger(id)||!this.#formatters.has(id))throw new TypeError('Invalid Intl formatter')
    const formatter=this.#formatters.get(id)!
    if(method==='resolved')return formatter.resolvedOptions()
    if(method==='format')return formatter.format(this.#time(args[1]))
    if(method==='parts')return formatter.formatToParts(this.#time(args[1]))
    const start=this.#time(args[1]),end=this.#time(args[2])
    return method==='range'?formatter.formatRange(start,end):formatter.formatRangeToParts(start,end)
  }
}
