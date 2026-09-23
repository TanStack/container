import {EventEmitter} from 'node:events'
import {createInterface} from 'node:readline'
import {inspect} from 'node:util'
import {builtinModules as moduleBuiltins} from 'node:module'
import process from 'node:process'

const unsupported=feature=>Object.assign(Error(feature+' is not implemented in this REPL'),{code:'ERR_UNSUPPORTED_OPERATION'})
export const REPL_MODE_SLOPPY=Symbol('repl-sloppy'),REPL_MODE_STRICT=Symbol('repl-strict')
export const builtinModules=Object.freeze(moduleBuiltins.filter(name=>!name.startsWith('_')&&!name.startsWith('node:')).slice())
export class Recoverable extends SyntaxError {constructor(error){super(error.message);this.err=error}}
export const writer=value=>inspect(value,{colors:false})
export function isValidSyntax(code){try{new Function(code);return true}catch{return false}}

const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
export function defaultEval(code,_context,_filename,callback){
  try{
    let result
    if(/^\s*await\b/.test(code))result=new AsyncFunction('return ('+code.trim().replace(/^await\s+/,'await ')+')')()
    else result=(0,eval)(code)
    callback(null,result)
  }catch(error){callback(error)}
}
const help='.break   Sometimes you get stuck, this gets you out\n.clear   Break, and also clear the local context\n.exit    Exit the REPL\n.help    Print this help message\n.load    Load JS from a file into the REPL session\n.save    Save all evaluated commands in this REPL session to a file\n\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n'

export class REPLServer extends EventEmitter {
  constructor(options={}){
    super()
    if(typeof options==='string')options={prompt:options}
    if(options.terminal===true||options.useColors===true)throw unsupported('Terminal mode')
    for(const name of ['completer','history','historySize','removeHistoryDuplicates','breakEvalOnSigint'])if(options[name]!==undefined)throw unsupported(name)
    this.input=options.input??process.stdin;this.output=options.output??process.stdout;this._prompt=options.prompt??'> ';this._continuationPrompt='| ';this.ignoreUndefined=Boolean(options.ignoreUndefined);this.eval=options.eval??defaultEval;this.writer=options.writer??writer;this.context=globalThis;this.lines=[];this.closed=false;this._globals=new Set(Reflect.ownKeys(globalThis));this._pending=Promise.resolve()
    this.rli=createInterface({input:this.input,terminal:false,crlfDelay:Infinity})
    this.rli.on('line',line=>{this._pending=this._pending.then(()=>this._line(line)).catch(error=>this._printError(error))})
    this.rli.on('close',()=>this._pending.then(()=>this._exit()))
    this.displayPrompt()
  }
  setPrompt(prompt){this._prompt=String(prompt)}
  getPrompt(){return this._prompt}
  prompt(preserveCursor){return this.displayPrompt(preserveCursor)}
  displayPrompt(_preserveCursor=false){if(!this.closed)this.output.write(this.lines.length?this._continuationPrompt:this._prompt)}
  clearBufferedCommand(){this.lines=[]}
  async _line(line){
    if(this.closed)return
    if(!this.lines.length&&line.startsWith('.')){
      if(line==='.exit'){this.rli.close();return}
      if(line==='.help'){this.output.write(help);this.displayPrompt();return}
      if(line==='.clear'||line==='.break'){
        this.lines=[]
        if(line==='.clear'){for(const key of Reflect.ownKeys(globalThis))if(!this._globals.has(key))try{delete globalThis[key]}catch{};this.output.write('Clearing context...\n');this.emit('reset',this.context)}
        this.displayPrompt();return
      }
      this.output.write('Invalid REPL keyword\n');this.displayPrompt();return
    }
    this.lines.push(line);const code=this.lines.join('\n')
    try{new Function(code)}catch(error){if(error instanceof SyntaxError&&(/Unexpected end|unterminated/i.test(error.message)||this._open(code)>0)){this.displayPrompt();return}}
    this.lines=[]
    const value=await new Promise((resolve,reject)=>this.eval(code+'\n',this.context,'repl',(error,result)=>error?reject(error):resolve(result)))
    const result=/^\s*await\b/.test(code)?await value:value
    if(result!==undefined||!this.ignoreUndefined)this.output.write(this.writer(result)+'\n')
    this.displayPrompt()
  }
  _open(code){let count=0;for(const char of code){if(char==='{'||char==='('||char==='[')count++;else if(char==='}'||char===')'||char===']')count--}return count}
  _printError(error){this.output.write((error?.stack??String(error))+'\n');this.lines=[];this.displayPrompt()}
  _exit(){if(this.closed)return;this.closed=true;this.emit('exit')}
  close(){this.rli.close()}
}

export function start(options){return new REPLServer(options)}
export default {REPLServer,start,defaultEval,writer,builtinModules,Recoverable,REPL_MODE_SLOPPY,REPL_MODE_STRICT,isValidSyntax}
