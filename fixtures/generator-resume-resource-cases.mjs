// QuickJS-specific resource expectations, not Node differential fixtures.
// Run source, then recoverySource with a separate JS_Eval in the SAME runtime.
// Set memoryLimitBytes before context creation and retain that cap for recovery.
// An interrupt is a harness failure, never a substitute for either expected error.
const recoverySource = `(()=>{
  function* fresh(){const input=yield 17;return input+1}
  const iterator=fresh(),first=iterator.next(),last=iterator.next(23),end=iterator.next();
  return {arithmetic:42,first,last,completed:end.done&&end.value===undefined};
})()`
const expectedRecovery = {
  arithmetic: 42,
  first: {value: 17, done: false},
  last: {value: 24, done: true},
  completed: true,
}

function sourceFor(kind) {
  const memory = kind === 'memory'
  return `(()=>{
    let entered=0,finalized=0,caught;
    function* nested(depth){
      entered++;
      let payload;
      try{
        ${memory ? 'payload=new ArrayBuffer(65536);' : ''}
        return depth?nested(depth-1).next().value+1:1;
      }finally{payload=undefined;finalized++}
    }
    const root=nested(8192);
    try{root.next()}catch(error){caught=error}
    if(!caught)throw new Error('Expected ${kind} failure, recursion completed');
    const name=caught.name,message=String(caught.message);
    if(name!=='InternalError'||message!==${JSON.stringify(memory ? 'out of memory' : 'stack overflow')})throw caught;
    if(entered===0||entered!==finalized)throw new Error('Generator frames did not fully unwind');
    ${memory
      ? "if(entered>=4095)throw new Error('Memory probe reached the frame boundary');"
      : "if(entered!==4095)throw new Error('Expected 4095 generator frames plus one wrapper continuation, saw '+entered);"}
    const end=root.next();
    if(!end.done||end.value!==undefined)throw new Error('Failed generator remained resumable');
    function* fresh(){yield 17;return 24}
    const iterator=fresh(),first=iterator.next(),last=iterator.next();
    return {
      category:${JSON.stringify(kind)},name,
      fullUnwind:entered===finalized,
      boundary:${memory ? "'before-frame-limit'" : 'entered+1'},
      completed:end.done&&end.value===undefined,
      first,last
    };
  })()`
}

export const cases = [
  {
    name: 'direct generator payload exhaustion unwinds under a 4 MiB cap',
    description: 'Each active generator holds a 64 KiB guest ArrayBuffer. Only an out-of-memory InternalError passes, before the interpreter-frame ceiling.',
    source: sourceFor('memory'),
    memoryLimitBytes: 4 * 1024 * 1024,
    expected: {
      category: 'memory', name: 'InternalError', fullUnwind: true,
      boundary: 'before-frame-limit', completed: true,
      first: {value: 17, done: false}, last: {value: 24, done: true},
    },
    recoverySource, expectedRecovery,
  },
  {
    name: 'direct generator recursion reaches the shared 4096 frame ceiling',
    description: 'One wrapper IIFE and 4095 active generator resumes fill the shared continuation limit. Only stack overflow passes, followed by complete unwind.',
    source: sourceFor('frames'),
    memoryLimitBytes: 32 * 1024 * 1024,
    expected: {
      category: 'frames', name: 'InternalError', fullUnwind: true,
      boundary: 4096, completed: true,
      first: {value: 17, done: false}, last: {value: 24, done: true},
    },
    recoverySource, expectedRecovery,
  },
]
