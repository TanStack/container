import {EventEmitter} from 'node:events'
import {StringDecoder} from 'node:string_decoder'
import process from 'node:process'

const error=(code,message)=>Object.assign(new Error(message),{code})
const callbackCheck=callback=>{if(callback!==undefined&&typeof callback!=='function')throw Object.assign(new TypeError('Expected callback'),{code:'ERR_INVALID_ARG_TYPE'})}
function write(stream,text,callback){
  callbackCheck(callback)
  if(stream==null||!text){if(callback)process.nextTick(callback,null);return true}
  return stream.write(text,callback)
}
export function cursorTo(stream,x,y,callback){
  callbackCheck(callback)
  if(typeof y==='function'){callback=y;y=undefined}
  if(Number.isNaN(x)||Number.isNaN(y))throw error('ERR_INVALID_ARG_VALUE','Invalid cursor coordinate')
  if(stream==null||(typeof x!=='number'&&typeof y!=='number'))return write(null,'',callback)
  if(typeof x!=='number')throw error('ERR_INVALID_CURSOR_POS','Cursor column is required')
  return write(stream,typeof y==='number'?`\x1b[${y+1};${x+1}H`:`\x1b[${x+1}G`,callback)
}
export function moveCursor(stream,dx,dy,callback){
  return write(stream,(dx<0?`\x1b[${-dx}D`:dx>0?`\x1b[${dx}C`:'')+(dy<0?`\x1b[${-dy}A`:dy>0?`\x1b[${dy}B`:''),callback)
}
export const clearLine=(stream,dir,callback)=>write(stream,`\x1b[${dir<0?1:dir>0?0:2}K`,callback)
export const clearScreenDown=(stream,callback)=>write(stream,'\x1b[0J',callback)
function signalCheck(signal){if(signal!==undefined&&(!signal||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))throw error('ERR_INVALID_ARG_TYPE','Expected AbortSignal')}
const abortError=signal=>Object.assign(error('ABORT_ERR','The operation was aborted'),{name:'AbortError',cause:signal.reason})

export class Interface extends EventEmitter {
  constructor(input,output,completer,terminal){
    super()
    const options=input&&typeof input.on!=='function'?input:{input,output,completer,terminal}
    if(!options?.input||typeof options.input.on!=='function')throw error('ERR_INVALID_ARG_TYPE','Expected input stream')
    this.input=options.input;this.output=options.output
    this.terminal=options.terminal??!!this.output?.isTTY
    this.escapeCodeTimeout=options.escapeCodeTimeout??500
    if(this.terminal)throw error('ERR_UNSUPPORTED_OPERATION','Readline terminal editing is not implemented')
    signalCheck(options.signal)
    this.closed=undefined;this.paused=false;this.line='';this.cursor=0
    this._prompt=options.prompt??'> ';this._buffer='';this._decoder=new StringDecoder('utf8')
    this._crlfDelay=Math.max(100,options.crlfDelay??100);this._lastCR=-Infinity
    this._onData=chunk=>this._consume(typeof chunk==='string'?chunk:this._decoder.write(chunk))
    this._onEnd=()=>{
      this._consume(this._decoder.end())
      if(this._buffer){const line=this._buffer;this._buffer='';this._line(line)}
      this.close()
    }
    this._onError=failure=>this.emit('error',failure)
    this.input.on('data',this._onData);this.input.on('end',this._onEnd);this.input.on('error',this._onError)
    if(options.signal){
      const abort=()=>this.close()
      options.signal.addEventListener('abort',abort,{once:true})
      this._disposeSignal=()=>options.signal.removeEventListener('abort',abort)
      if(options.signal.aborted)process.nextTick(abort)
    }
    this.input.resume()
  }
  _consume(text){
    if(this.closed||!text)return
    let start=0
    if(this._lastCR!==-Infinity){if(text[0]==='\n'&&Date.now()-this._lastCR<=this._crlfDelay)start=1;this._lastCR=-Infinity}
    for(let index=start;index<text.length;index++){
      const char=text[index]
      if(char!=='\n'&&char!=='\r')continue
      const line=this._buffer+text.slice(start,index);this._buffer=''
      if(char==='\r'){
        if(text[index+1]==='\n')index++
        else if(index===text.length-1)this._lastCR=Date.now()
      }
      start=index+1;this._line(line)
      if(this.closed)return
    }
    this._buffer+=text.slice(start)
  }
  _line(line){
    if(this._question){const pending=this._question;this._question=undefined;pending.cleanup();this._prompt=pending.prompt;pending.callback(line)}
    else this.emit('line',line)
  }
  setPrompt(prompt){this._prompt=prompt}
  getPrompt(){return this._prompt}
  prompt(){this.resume();this.output?.write(this._prompt)}
  pause(){if(!this.paused){this.input.pause();this.paused=true;this.emit('pause')}return this}
  resume(){if(this.paused){this.input.resume();this.paused=false;this.emit('resume')}return this}
  close(){
    if(this.closed)return
    this.pause();this.closed=true
    this.input.removeListener('data',this._onData);this.input.removeListener('end',this._onEnd);this.input.removeListener('error',this._onError)
    this._disposeSignal?.();this._question?.cleanup();this._question=undefined
    this.emit('close')
  }
  [Symbol.dispose](){this.close()}
  write(data,key){if(this.closed)return;this.resume();if(data)this._onData(data)}
  question(query,options,callback){
    if(typeof options==='function'){callback=options;options={}}
    options??={};signalCheck(options.signal)
    if(options.signal?.aborted||typeof callback!=='function')return
    if(this.closed)throw error('ERR_USE_AFTER_CLOSE','readline was closed')
    if(this._question){this.prompt();return}
    const prompt=this._prompt,signal=options.signal
    const cancel=()=>{this._question=undefined;this._prompt=prompt;this._buffer='';signal.removeEventListener('abort',cancel)}
    this._question={callback,prompt,cleanup:()=>signal?.removeEventListener('abort',cancel)}
    signal?.addEventListener('abort',cancel,{once:true})
    this._prompt=query;this.prompt()
  }
  [Symbol.asyncIterator](){
    if(this._iterator)return this._iterator
    const queue=[],waiters=[];let done=!!this.closed,failure,paused=false
    const line=value=>{
      if(waiters.length)waiters.shift().resolve({value,done:false})
      else {queue.push(value);if(queue.length>1024&&!paused){paused=true;this.pause()}}
    }
    const cleanup=()=>{this.removeListener('line',line);this.removeListener('close',close);this.removeListener('error',onError)}
    const close=()=>{done=true;while(waiters.length)waiters.shift().resolve({value:undefined,done:true});cleanup()}
    const onError=error=>{failure=error;if(waiters.length){waiters.shift().reject(error);failure=undefined}close()}
    this.on('line',line);this.once('close',close);this.on('error',onError)
    this._iterator={
      next:()=>{
        if(queue.length){const value=queue.shift();if(paused&&queue.length<1){paused=false;this.resume()}return Promise.resolve({value,done:false})}
        if(failure){const error=failure;failure=undefined;return Promise.reject(error)}
        return done?Promise.resolve({done:true,value:undefined}):new Promise((resolve,reject)=>waiters.push({resolve,reject}))
      },
      return:async()=>{queue.length=0;failure=undefined;close();return {done:true,value:undefined}},
      [Symbol.asyncIterator](){return this},
    }
    return this._iterator
  }
}
export const createInterface=(...args)=>new Interface(...args)
const keypressDecoders=new WeakMap()
export function emitKeypressEvents(stream,iface){
  if(keypressDecoders.has(stream))return
  const decoder=new StringDecoder('utf8')
  let pending='',timer
  const emit=sequence=>{
    const key={sequence,name:undefined,ctrl:false,meta:false,shift:false}
    let character=sequence
    const arrows={'\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left','\x1b[H':'home','\x1b[F':'end','\x1b[3~':'delete','\x1b[5~':'pageup','\x1b[6~':'pagedown'}
    if(arrows[sequence]){key.name=arrows[sequence];key.code=sequence.slice(1);character=undefined}
    else if(sequence==='\r')key.name='return'
    else if(sequence==='\n')key.name='enter'
    else if(sequence==='\t')key.name='tab'
    else if(sequence==='\x7f'||sequence==='\b')key.name='backspace'
    else if(sequence==='\x1b'){key.name='escape';key.meta=true;character=undefined}
    else if(sequence.length===2&&sequence[0]==='\x1b'){key.meta=true;key.name=sequence[1].toLowerCase();key.shift=/[A-Z]/.test(sequence[1]);character=undefined}
    else if(sequence.length===1&&sequence.charCodeAt(0)>0&&sequence.charCodeAt(0)<=26){key.name=String.fromCharCode(sequence.charCodeAt(0)+96);key.ctrl=true}
    else if(sequence===' ')key.name='space'
    else if(/^[a-zA-Z0-9]$/.test(sequence)){key.name=sequence.toLowerCase();key.shift=/[A-Z]/.test(sequence)}
    stream.emit('keypress',character,key)
  }
  const consume=text=>{
    clearTimeout(timer);pending+=text
    while(pending){
      let sequence
      if(pending[0]==='\x1b'){
        if(pending.length===1)break
        if(pending[1]==='['||pending[1]==='O'){
          const match=pending.match(/^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/)
          if(!match){if(pending.length<32)break;sequence=pending[0]}else sequence=match[0]
        }else sequence=Array.from(pending).slice(0,2).join('')
      }else sequence=String.fromCodePoint(pending.codePointAt(0))
      pending=pending.slice(sequence.length);emit(sequence)
    }
    if(pending)timer=setTimeout(()=>{const rest=pending;pending='';emit(rest)},iface?.escapeCodeTimeout??500)
  }
  const onData=chunk=>{if(!stream.listenerCount('keypress'))return;consume(typeof chunk==='string'?chunk:decoder.write(chunk))}
  const onEnd=()=>{consume(decoder.end());if(pending){clearTimeout(timer);const rest=pending;pending='';emit(rest)}}
  let attached=false
  const attach=()=>{if(!attached){attached=true;stream.on('data',onData)}}
  stream.on('newListener',name=>{if(name==='keypress')attach()})
  stream.on('removeListener',name=>{if(name==='keypress'&&!stream.listenerCount('keypress')){stream.removeListener('data',onData);attached=false;clearTimeout(timer);pending=''}})
  keypressDecoders.set(stream,{onData,onEnd})
  if(stream.listenerCount('keypress'))attach()
  stream.once('end',onEnd)
}
class PromiseInterface extends Interface {
  question(query,options={}){
    return new Promise((resolve,reject)=>{
      signalCheck(options.signal)
      if(options.signal?.aborted){reject(abortError(options.signal));return}
      const abort=()=>{cleanup();reject(abortError(options.signal))}
      const cleanup=()=>options.signal?.removeEventListener('abort',abort)
      options.signal?.addEventListener('abort',abort,{once:true})
      try{super.question(query,options,answer=>{cleanup();resolve(answer)})}catch(failure){cleanup();reject(failure)}
    })
  }
}
export const promises={Interface:PromiseInterface,createInterface:(...args)=>new PromiseInterface(...args)}
export default {Interface,createInterface,emitKeypressEvents,cursorTo,moveCursor,clearLine,clearScreenDown,promises}
