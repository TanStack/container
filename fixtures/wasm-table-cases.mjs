export const wasmTableCoreCases=fixtures=>[
  {name:'explicit zero maximum refuses growth',fixture:'growth',code:'return [e.closedGrow(0),e.closedGrow(1),e.closedSize(),e.closedGrow(0)]'},
  {name:'declared maximum and failed growth preserve size',fixture:'growth',code:'return [e.boundedGrow(1),e.boundedGrow(1),e.boundedGrow(1),e.boundedSize(),e.boundedGrow(-1),e.boundedSize()]'},
  {name:'absent maximum permits growth',fixture:'growth',code:'return [e.openGrow(1),e.openGrow(2),e.openSize(),e.openGrow(0)]'},
  {name:'active elements, null traps and recovery',fixture:'elements',code:'return [e.call(0),e.call(1),attempt(()=>e.call(2)),attempt(()=>e.call(4)),e.call(0)]'},
  {name:'overlapping table copy and bounds are atomic',fixture:'elements',code:'e.copy(1,0,3);const before=[e.call(0),e.call(1),e.call(2),attempt(()=>e.call(3))];const failure=attempt(()=>e.copy(0,2,3));return [before,failure,e.call(0),e.call(1),e.call(2)]'},
  {name:'fill, clear and out-of-bounds fill',fixture:'elements',code:'e.fill(1,3);e.clear(2);const failure=attempt(()=>e.fill(3,2));return [e.call(0),e.call(1),attempt(()=>e.call(2)),e.call(3),failure,e.call(3)]'},
  {name:'passive segment initialization, drop and bounds',fixture:'elements',code:'e.init(2,0,2);const values=[e.call(2),e.call(3)];e.drop();return [values,attempt(()=>e.init(0,0,1)),attempt(()=>e.init(4,0,0)),attempt(()=>e.init(5,0,0)),e.call(0)]'},
  {name:'grown slots receive the function reference',fixture:'elements',code:'return [e.grow(2),e.size(),e.call(4),e.call(5),e.grow(3),e.size(),e.call(4)]'},
].map(fixture=>({name:'table core: '+fixture.name,code:`JSON.stringify((()=>{const e=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(${JSON.stringify(fixtures[fixture.fixture])}))).exports;const attempt=fn=>{try{return fn()??'ok'}catch(error){return error.name}};${fixture.code}})())`}))
