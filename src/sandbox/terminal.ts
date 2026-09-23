export interface TerminalOptions {columns:number;rows:number}
export function terminalOptions(value:unknown):TerminalOptions|undefined {
  if(value===undefined)return
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='columns'&&key!=='rows'))throw new TypeError('Expected terminal columns and rows')
  const {columns,rows}=value as TerminalOptions
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||columns>1000||rows>1000)throw new RangeError('Terminal dimensions must be integers between 1 and 1000')
  return {columns,rows}
}
/** A bounded virtual terminal line discipline, not a host PTY. */
export class VirtualTerminal {
  raw=false
  #line:number[]=[]
  #writing=false
  constructor(readonly size:TerminalOptions,private input:(bytes:Uint8Array)=>Promise<void>,private echo:(bytes:Uint8Array)=>Promise<void>,private interrupt:()=>void){}
  setRawMode(raw:boolean){this.raw=raw}
  async write(bytes:Uint8Array){
    if(this.#writing)throw Object.assign(Error('A terminal write is already pending'),{code:'EBUSY'})
    this.#writing=true
    try{await this.#write(bytes.slice())}finally{this.#writing=false}
  }
  async #write(bytes:Uint8Array){
    if(this.raw)return this.input(bytes)
    for(const byte of bytes){
      if(byte===3){this.#line=[];await this.echo(new TextEncoder().encode('^C\r\n'));this.interrupt();return}
      if(byte===127||byte===8){if(this.#line.length){let removed=this.#line.pop()!;while((removed&192)===128&&this.#line.length)removed=this.#line.pop()!;await this.echo(new Uint8Array([8,32,8]))}continue}
      if(byte===13||byte===10){const line=new Uint8Array([...this.#line,10]);this.#line=[];await this.echo(new Uint8Array([13,10]));await this.input(line);continue}
      if(byte<32)throw Object.assign(Error('Unsupported cooked terminal control byte'),{code:'ERR_UNSUPPORTED_OPERATION'})
      if(this.#line.length>=65536)throw Object.assign(Error('Terminal input line limit exceeded'),{code:'ERR_RESOURCE_LIMIT'})
      this.#line.push(byte);await this.echo(new Uint8Array([byte]))
    }
  }
}
