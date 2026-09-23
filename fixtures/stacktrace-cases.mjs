export const stacktraceCases=[
  {name:'nested function locations survive distant Unicode source positions',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;
    ${Array.from({length:40},(_,i)=>`function outer${i}(){
      /* ${'é中😀'.repeat(600)} */
      function inner${i}(){const error={};Error.captureStackTrace(error);return error.stack.slice(0,2).map(site=>[site.getFunctionName(),site.getLineNumber(),site.getColumnNumber()])}
      return inner${i}();
    }`).join('\n')}
    return [${Array.from({length:40},(_,i)=>`outer${i}()`).join(',')}];
  })()`},
  {name:'ordinary frames are not eval and direct eval frames are',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;const error={};Error.captureStackTrace(error);
    const ordinary=[error.stack[0].isEval(),typeof error.stack[0].getEvalOrigin()];
    const evaluated=eval('var captured={};Error.captureStackTrace(captured);captured.stack[0].isEval()');return [...ordinary,evaluated];
  })()`},
  {name:'structured frame names, source lines and retention',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;
    function inner(){const error={};Error.captureStackTrace(error);return error.stack}
    function outer(){return inner()}
    const sites=outer();return sites.slice(0,2).map(s=>[s.getFunctionName(),s.getFileName(),s.getLineNumber(),s.getFunction()===inner,s.isNative()]);
  })()`},
  {name:'constructor filtering uses function identity, not names',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;
    const other=function same(){};
    const same=function same(){const a={},b={};Error.captureStackTrace(a,same);Error.captureStackTrace(b,other);return [a.stack[0].getFunctionName(),b.stack.length]};
    function caller(){return same()}return caller();
  })()`},
  {name:'strict frames hide function and receiver through their callers',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;
    function strict(){'use strict';const error={};Error.captureStackTrace(error);return error.stack.slice(0,2).map(s=>[s.getFunctionName(),typeof s.getThis(),typeof s.getFunction()])}
    function outer(){return strict()}return outer();
  })()`},
  {name:'method receiver, function identity and type name',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;
    function Owner(){};Owner.prototype.work=function work(){const error={};Error.captureStackTrace(error);return error.stack[0]};
    const owner=new Owner(),site=owner.work();return [site.getThis()===owner,site.getFunction()===owner.work,site.getFunctionName(),site.getTypeName(),site.getMethodName(),site.isConstructor(),site.isToplevel()];
  })()`},
  {name:'lazy formatter caches arbitrary return values',code:`(()=>{
    let calls=0;const error={};Error.captureStackTrace(error);Error.prepareStackTrace=(value,sites)=>({same:value===error,count:sites.length,calls:++calls});Error.stackTraceLimit=0;
    const first=error.stack,second=error.stack;return [calls,first===second,first.same,first.count>0,Object.keys(error).length,Object.getOwnPropertyDescriptor(error,'stack').configurable];
  })()`},
  {name:'assigned stack bypasses formatter and can be deleted',code:`(()=>{
    let calls=0;Error.prepareStackTrace=()=>{calls++;return 'formatted'};const error={};Error.captureStackTrace(error);error.stack=42;const value=error.stack;delete error.stack;return [value,calls,Object.hasOwn(error,'stack')];
  })()`},
  {name:'formatter throws and can be retried',code:`(()=>{
    const error={};Error.captureStackTrace(error);Error.prepareStackTrace=()=>{throw Error('formatter failed')};let caught;try{error.stack}catch(e){caught=e.message}Error.prepareStackTrace=()=>23;return [caught,error.stack];
  })()`},
  {name:'recursive formatter falls back without recursing forever',code:`(()=>{
    let calls=0;Error.prepareStackTrace=error=>{calls++;return ['outer',typeof error.stack]};const error={};Error.captureStackTrace(error);return [error.stack,calls];
  })()`},
  {name:'stack limits use numbers without coercing other types',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites.length;const out=[];
    for(const limit of [undefined,null,'3',NaN,-1,0,1.5,2]){Error.stackTraceLimit=limit;const error={};Error.captureStackTrace(error);out.push(error.stack===undefined?'undefined':error.stack)}return out;
  })()`},
  {name:'invalid targets reject and capture does not invoke inherited numeric setters',code:`(()=>{
    const out=[];for(const target of [null,1,'x',Object.freeze({})]){try{Error.captureStackTrace(target);out.push('ok')}catch(e){out.push(e.name)}}
    let called=0;Object.defineProperty(Array.prototype,'0',{set(){called++},configurable:true});const error={};Error.captureStackTrace(error);delete Array.prototype[0];return [...out,called,typeof error.stack];
  })()`},
  {name:'borrowed CallSite methods reject the wrong receiver',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;const error={};Error.captureStackTrace(error);try{error.stack[0].getFileName.call({});return 'accepted'}catch(e){return e.name}
  })()`},
  {name:'source column coordinates match Node',code:`(()=>{
    Error.prepareStackTrace=(error,sites)=>sites;
    function capture(){const error={};Error.captureStackTrace(error);return error.stack[0].getColumnNumber()}
    return capture();
  })()`},
]
