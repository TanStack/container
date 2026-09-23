// Each source is a bounded synchronous expression. Results preserve operation
// order and normalize only undefined values and engine-specific error messages.
export const cases = [
  {name: 'bounded direct next overflow unwinds and permits fresh generators', source: `(()=>{
    const results=[];
    for(let attempt=0;attempt<3;attempt++){
      let entered=0,finalized=0,caught=false,errorObject=false;
      function* nested(depth){
        entered++;
        try{return depth?nested(depth-1).next().value+1:1}
        finally{finalized++}
      }
      try{nested(16384).next()}catch(error){caught=true;errorObject=error!==null&&typeof error==='object'}
      function* fresh(){const sent=yield 17;return sent+1}
      const iterator=fresh(),first=iterator.next(),last=iterator.next(23),completed=iterator.next();
      results.push({requestedDepth:16384,caught,errorObject,enteredBody:entered>0,fullyUnwound:entered===finalized,first,last,completed:completed.done&&completed.value===undefined});
    }
    return results;
  })()`},
  {name: 'direct next through 512 nested generators preserves yield and return order', source: `(()=>{
    const order=[];
    function* nested(depth){
      order.push(['enter',depth]);
      if(depth===0){const sent=yield 7;order.push(['leaf-sent',sent]);return 11}
      const child=nested(depth-1),first=child.next();
      order.push(['yield',depth,first.done]);
      const sent=yield first.value+1;
      const last=child.next(sent);
      order.push(['return',depth,last.done]);
      return last.value+1;
    }
    const root=nested(512),first=root.next('ignored'),last=root.next(23),completed=root.next();
    return {first,last,completed:{done:completed.done,undefinedValue:completed.value===undefined},order};
  })()`},
  {name: 'direct return through 512 suspended generators runs each finally once', source: `(()=>{
    const order=[];
    function* nested(depth){
      const child=depth?nested(depth-1):null;
      if(child)child.next();
      try{yield depth}finally{
        order.push(['finally',depth]);
        if(child){const result=child.return(99);order.push(['child-return',depth,result.value,result.done])}
      }
    }
    const root=nested(512),first=root.next(),last=root.return(99),completed=root.next();
    return {first,last,completed:completed.done&&completed.value===undefined,order};
  })()`},
  {name: 'direct throw through 512 suspended generators preserves thrown identity', source: `(()=>{
    const reason={},order=[];
    function* nested(depth){
      const child=depth?nested(depth-1):null;
      if(child)child.next();
      try{yield depth}catch(error){
        order.push(['catch',depth,error===reason]);
        if(child){const result=child.throw(error);order.push(['child-done',depth,result.done]);return result.value+1}
        return 7;
      }finally{order.push(['finally',depth])}
    }
    const root=nested(512),first=root.next(),last=root.throw(reason),completed=root.next();
    return {first,last,completed:completed.done&&completed.value===undefined,order};
  })()`},
  {name: 'normal next arguments yields and repeated completion', source: `(()=>{
    const order=[];
    function* sequence(){order.push('start');const a=yield 1;order.push(['a',a]);const b=yield a+2;order.push(['b',b]);return b+3}
    const iterator=sequence(),results=[iterator.next(999),iterator.next(10),iterator.next(20)];
    for(let i=0;i<3;i++){const result=iterator.next(i);results.push({done:result.done,undefinedValue:result.value===undefined})}
    return {results,order};
  })()`},
  {name: 'throw before first next never enters generator body', source: `(()=>{
    let entered=false,finalized=false;const reason={};
    function* sequence(){try{entered=true;yield 1}finally{finalized=true}}
    const iterator=sequence();let same=false;try{iterator.throw(reason)}catch(error){same=error===reason}
    const after=iterator.next();return {entered,finalized,same,after:after.done&&after.value===undefined};
  })()`},
  {name: 'return before first next never enters generator body', source: `(()=>{
    let entered=false,finalized=false;
    function* sequence(){try{entered=true;yield 1}finally{finalized=true}}
    const iterator=sequence(),result=iterator.return(42),after=iterator.next();
    return {entered,finalized,result,after:after.done&&after.value===undefined};
  })()`},
  {name: 'injected throw can yield in catch and complete through finally', source: `(()=>{
    const reason={},order=[];
    function* sequence(){try{yield 'body'}catch(error){order.push(error===reason);const sent=yield 'caught';order.push(sent);return 'handled'}finally{order.push('finally')}}
    const iterator=sequence(),results=[iterator.next(),iterator.throw(reason),iterator.next('resume')];
    return {results,order};
  })()`},
  {name: 'return remains pending across a yield in finally', source: `(()=>{
    const order=[];
    function* sequence(){try{yield 'body'}finally{order.push('finally-start');const sent=yield 'cleanup';order.push(['finally-resume',sent])}}
    const iterator=sequence(),results=[iterator.next(),iterator.return(42),iterator.next('resume')];
    return {results,order};
  })()`},
  {name: 'throw replaces pending return while finally is suspended', source: `(()=>{
    const reason={},order=[];
    function* sequence(){try{yield 'body'}finally{try{yield 'cleanup'}finally{order.push('inner-finally')}}}
    const iterator=sequence(),results=[iterator.next(),iterator.return(42)];let same=false;
    try{iterator.throw(reason)}catch(error){same=error===reason}
    const after=iterator.next();return {results,same,order,after:after.done&&after.value===undefined};
  })()`},
  {name: 'finally return overrides injected throw', source: `(()=>{
    const order=[];
    function* sequence(){try{yield 'body'}finally{order.push('finally');return 73}}
    const iterator=sequence(),results=[iterator.next(),iterator.throw({})];return {results,order};
  })()`},
  {name: 'executing generator rejects next return and throw reentry', source: `(()=>{
    const names=[];let iterator;
    function* sequence(){
      try{iterator.next()}catch(error){names.push(['next',error.name])}
      try{iterator.return(5)}catch(error){names.push(['return',error.name])}
      try{iterator.throw(6)}catch(error){names.push(['throw',error.name])}
      yield 7;return 8;
    }
    iterator=sequence();return {results:[iterator.next(),iterator.next()],names};
  })()`},
  {name: 'detached and wrong receiver intrinsic methods reject without consuming iterator', source: `(()=>{
    function* sequence(){yield 4;return 5}
    const iterator=sequence(),names=[];
    for(const name of ['next','return','throw']){
      const detached=iterator[name];try{detached(1)}catch(error){names.push(['detached',name,error.name])}
      const wrong={resume:iterator[name]};try{wrong.resume(1)}catch(error){names.push(['wrong',name,error.name])}
    }
    return {names,results:[iterator.next(),iterator.next()]};
  })()`},
  {name: 'completed generator return and throw preserve arguments on repeated calls', source: `(()=>{
    function* sequence(){return 1}
    const iterator=sequence(),first=iterator.next(),results=[];
    for(let i=0;i<3;i++){
      const reason={i};let same=false;try{iterator.throw(reason)}catch(error){same=error===reason}
      const returned=iterator.return(i),next=iterator.next(i);
      results.push({same,returned,next:next.done&&next.value===undefined});
    }
    return {first,results};
  })()`},
]
