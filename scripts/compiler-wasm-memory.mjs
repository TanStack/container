import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import ts from 'typescript'

// Read the pinned compilers' imported wasm32 memory ABI, never rewrite WASM.
// Unsupported import encodings fail the build rather than guessing a size.
// Binary limits: https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md
export function compilerWasmMemory(input){
  assert(input instanceof Uint8Array,'Expected compiler WASM bytes')
  assert(input.byteLength<=128*1024*1024,'Compiler WASM exceeds the build inspection limit')
  assert(WebAssembly.validate(input),'Invalid compiler WASM')
  let offset=8,end=input.length
  const byte=()=>{assert(offset<end,'Incomplete compiler WASM section');return input[offset++]}
  const u32=()=>{
    let value=0
    for(let index=0;index<5;index++){
      const part=byte()
      assert(index!==4||part<=15,'Invalid compiler WASM u32')
      value+=(part&127)*2**(index*7)
      if(!(part&128))return value
    }
    throw Error('Invalid compiler WASM u32')
  }
  const decoder=new TextDecoder('utf8',{fatal:true})
  const name=()=>{
    const length=u32()
    assert(length<=end-offset,'Incomplete compiler WASM import name')
    const value=decoder.decode(input.subarray(offset,offset+length))
    offset+=length
    return value
  }
  const limits=memory=>{
    const flags=u32()
    assert(memory?flags<=3:flags<=1,'Unsupported compiler WASM limits')
    const minimum=u32(),maximum=flags&1?u32():null
    return {minimum,maximum,shared:Boolean(flags&2)}
  }
  const valueType=()=>{
    assert([0x7f,0x7e,0x7d,0x7c,0x7b,0x70,0x6f].includes(byte()),
      'Unsupported compiler WASM import value type')
  }
  const memories=[]
  let importsSeen=false
  while(offset<input.length){
    end=input.length
    const id=byte(),length=u32()
    assert(length<=input.length-offset,'Incomplete compiler WASM section')
    end=offset+length
    if(id===2){
      assert(!importsSeen,'Duplicate compiler WASM import section')
      importsSeen=true
      const count=u32()
      assert(count<=Math.floor((end-offset)/4),'Invalid compiler WASM import count')
      for(let index=0;index<count;index++){
        const module=name(),importName=name(),kind=byte()
        if(kind===0)u32()
        else if(kind===1){
          assert([0x70,0x6f].includes(byte()),'Unsupported compiler WASM table import')
          limits(false)
        }else if(kind===2)memories.push({module,name:importName,...limits(true)})
        else if(kind===3){valueType();assert(byte()<=1,'Invalid compiler WASM global mutability')}
        else if(kind===4){assert(byte()===0,'Unsupported compiler WASM tag import');u32()}
        else throw Error('Unsupported compiler WASM import kind')
      }
      assert.equal(offset,end,'Unexpected compiler WASM import bytes')
    }else if(id===5){
      assert.equal(u32(),0,'Compiler must use only its imported memory')
      assert.equal(offset,end,'Unexpected compiler WASM memory bytes')
    }
    offset=end
  }
  assert.equal(memories.length,1,'Expected exactly one imported compiler memory')
  const memory=memories[0]
  assert.equal(memory.module,'env','Unexpected compiler memory module')
  assert.equal(memory.name,'memory','Unexpected compiler memory import')
  assert.equal(memory.shared,true,'Compiler memory must remain shared')
  assert(memory.maximum!==null&&memory.minimum<=memory.maximum&&memory.maximum<=65536,
    'Invalid shared wasm32 compiler memory limits')
  return {module:memory.module,name:memory.name,initialPages:memory.minimum,
    maximumPages:memory.maximum,shared:memory.shared,
    wasmSHA256:createHash('sha256').update(input).digest('hex')}
}

export function sizeCompilerMemoryBinding(source,wasm){
  const memory=compilerWasmMemory(wasm)
  const file=ts.createSourceFile('compiler-binding.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  assert.equal(file.parseDiagnostics.length,0,'Invalid compiler binding source')
  const constructors=[]
  function visit(node){
    if(ts.isNewExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&
      ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='WebAssembly'&&
      node.expression.name.text==='Memory')constructors.push(node)
    ts.forEachChild(node,visit)
  }
  visit(file)
  assert.equal(constructors.length,1,'Expected exactly one compiler memory constructor')
  const node=constructors[0]
  assert(node.arguments?.length===1&&ts.isObjectLiteralExpression(node.arguments[0]),
    'Expected a literal compiler memory descriptor')
  const properties=new Map()
  for(const property of node.arguments[0].properties){
    assert(ts.isPropertyAssignment(property)&&ts.isIdentifier(property.name),
      'Unexpected compiler memory property')
    assert(!properties.has(property.name.text),'Duplicate compiler memory property')
    properties.set(property.name.text,property.initializer)
  }
  assert.deepEqual([...properties.keys()].sort(),['initial','maximum','shared'],
    'Unexpected compiler memory descriptor properties')
  const initial=properties.get('initial'),maximum=properties.get('maximum'),shared=properties.get('shared')
  assert(ts.isNumericLiteral(initial)&&ts.isNumericLiteral(maximum),
    'Expected literal compiler memory limits')
  assert.equal(shared.kind,ts.SyntaxKind.TrueKeyword,'Compiler binding must retain shared memory')
  assert.equal(Number(maximum.text),memory.maximumPages,'Compiler memory maximum differs from WASM')
  const upstreamInitialPages=Number(initial.text)
  assert(Number.isSafeInteger(upstreamInitialPages)&&upstreamInitialPages>=memory.initialPages&&
    upstreamInitialPages<=memory.maximumPages,'Compiler binding has incompatible initial memory')
  // Change only the initial numeric token in the build input. The import,
  // maximum, shared flag, growth implementation and WASM bytes stay intact.
  const contents=source.slice(0,initial.getStart(file))+memory.initialPages+source.slice(initial.end)
  return {contents,memory:{...memory,upstreamInitialPages}}
}
