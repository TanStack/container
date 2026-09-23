function attachTerminal(process,host){
 const state=host.proc?.call('terminalState')
 if(!state)return
 process.stdin.isTTY=true;process.stdin.isRaw=state.raw
 process.stdin.setRawMode=function(value){host.proc.call('terminalRaw',!!value);this.isRaw=!!value;return this}
 for(const stream of [process.stdout,process.stderr]){
  stream.isTTY=true;stream.columns=state.columns;stream.rows=state.rows
  stream.getWindowSize=()=>[stream.columns,stream.rows]
 }
}
