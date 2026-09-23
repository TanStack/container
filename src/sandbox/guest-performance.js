// Guest-owned user timing. Only the monotonic clock crosses the VM boundary.
const host=globalThis.__webContainerHost
const now=()=>{if(!host.now)throw Error('Monotonic clock is unavailable in this backend');return host.now()}
const entries=[],observers=new Set()
const queued=new Set()
let pending=false
function schedule(observer){
  queued.add(observer)
  if(pending)return
  pending=true
  // A shared delivery batch inherits the context that first queued it, not
  // each observer's construction context. Deliver after promise jobs drain.
  setTimeout(()=>{
    pending=false;const batch=[...queued];queued.clear()
    for(const observer of batch){const records=observer.takeRecords();if(records.length)observer.callback(listing(records),observer)}
  },0)
}
const supported=['mark','measure']
const clone=value=>value===undefined?null:structuredClone(value)
const invalid=message=>Object.assign(new TypeError(message),{code:'ERR_INVALID_ARG_VALUE'})
export class PerformanceEntry {
  constructor(name,type,startTime,duration,detail){Object.defineProperties(this,Object.fromEntries(Object.entries({name,entryType:type,startTime,duration,detail}).map(([key,value])=>[key,{value,enumerable:true}]))) }
  toJSON(){return {name:this.name,entryType:this.entryType,startTime:this.startTime,duration:this.duration,detail:this.detail}}
}
export class PerformanceMark extends PerformanceEntry {
  constructor(name,options={}){
    const start=options.startTime??now()
    if(typeof start!=='number'||!Number.isFinite(start)||start<0)throw invalid('Invalid mark startTime')
    super(String(name),'mark',start,0,clone(options.detail))
  }
}
export class PerformanceMeasure extends PerformanceEntry {}
const ordered=list=>list.slice().sort((a,b)=>a.startTime-b.startTime)
const listing=list=>({getEntries:()=>ordered(list),getEntriesByType:type=>ordered(list.filter(e=>e.entryType===type)),getEntriesByName:(name,type)=>ordered(list.filter(e=>e.name===name&&(!type||e.entryType===type)))})
function publish(entry){
  if(entries.length>=1024)throw Object.assign(Error('Performance entry quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
  if([...observers].some(observer=>observer.types.has(entry.entryType)&&observer.queue.length>=1024))throw Object.assign(Error('Performance observer queue quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
  entries.push(entry)
  for(const observer of observers)if(observer.types.has(entry.entryType))observer.enqueue(entry)
  return entry
}
export class PerformanceObserver {
  static get supportedEntryTypes(){return supported.slice()}
  constructor(callback){if(typeof callback!=='function')throw new TypeError('Expected observer callback');this.callback=callback;this.types=new Set();this.queue=[]}
  observe(options){
    if(!options||options.entryTypes&&options.type)throw invalid('Specify type or entryTypes')
    const types=options.entryTypes??[options.type]
    if(!Array.isArray(types)||types.some(type=>typeof type!=='string'))throw invalid('Expected entry types')
    this.types=new Set(types.filter(type=>supported.includes(type)))
    if(!observers.has(this)&&observers.size>=128)throw Object.assign(Error('Performance observer quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
    observers.add(this)
    if(options.buffered&&options.type)for(const entry of entries)if(this.types.has(entry.entryType))this.enqueue(entry)
  }
  enqueue(entry){
    if(this.queue.length>=1024)throw Object.assign(Error('Performance observer queue quota exceeded'),{code:'ERR_RESOURCE_LIMIT'})
    this.queue.push(entry)
    schedule(this)
  }
  takeRecords(){const records=this.queue;this.queue=[];return records}
  disconnect(){observers.delete(this);queued.delete(this);this.queue=[];this.types.clear()}
}
function time(value,fallback){
  if(value===undefined)return fallback
  if(typeof value==='number'){if(!Number.isFinite(value)||value<0)throw invalid('Invalid timing value');return value}
  const mark=entries.findLast(entry=>entry.entryType==='mark'&&entry.name===String(value))
  if(!mark)throw Object.assign(Error('The mark does not exist: '+value),{name:'SyntaxError'})
  return mark.startTime
}
export const performance={
  now,timeOrigin:host.timeOrigin,
  mark:(name,options)=>publish(new PerformanceMark(name,options)),
  measure(name,startOrOptions,endMark){
    let start,end,detail=null
    if(startOrOptions&&typeof startOrOptions==='object'){
      const options=startOrOptions
      if(endMark!==undefined||options.start!==undefined&&options.end!==undefined&&options.duration!==undefined)throw invalid('Invalid measure options')
      if(options.duration!==undefined&&options.start===undefined&&options.end===undefined)throw invalid('Duration requires start or end')
      start=time(options.start,0);end=time(options.end,now());detail=clone(options.detail)
      if(options.duration!==undefined){const duration=time(options.duration,0);if(options.end!==undefined)start=end-duration;else end=start+duration}
    }else{start=time(startOrOptions,0);end=time(endMark,now())}
    return publish(new PerformanceMeasure(String(name),'measure',start,end-start,detail))
  },
  ...listing(entries),
  clearMarks:name=>{for(let i=entries.length-1;i>=0;i--)if(entries[i].entryType==='mark'&&(name===undefined||entries[i].name===String(name)))entries.splice(i,1)},
  clearMeasures:name=>{for(let i=entries.length-1;i>=0;i--)if(entries[i].entryType==='measure'&&(name===undefined||entries[i].name===String(name)))entries.splice(i,1)},
}
export default {performance,PerformanceEntry,PerformanceMark,PerformanceMeasure,PerformanceObserver}
