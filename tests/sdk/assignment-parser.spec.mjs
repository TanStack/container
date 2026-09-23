import {test,expect} from '@playwright/test'
import {createServer} from 'node:http'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,sep,extname} from 'node:path'

const root=realpathSync(process.env.SDK_OUTPUT)
let server,url
test.beforeAll(async()=>{
  server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/'){res.setHeader('content-type','text/html');res.end('<script type="module">import * as sdk from "/sdk/index.js";window.sdk=sdk</script>');return}
    try{
      if(!path.startsWith('/sdk/'))throw Error('outside package')
      const file=realpathSync(resolve(root,decodeURIComponent(path.slice(5))))
      if(!file.startsWith(root+sep))throw Error('outside package')
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream')
      res.end(readFileSync(file))
    }catch{res.statusCode=404;res.end()}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}`
})
test.afterAll(async()=>{if(server)await new Promise(done=>server.close(done))})

const cases=[
  `const events=[];const o={set x(v){events.push(v)}};function ref(n){events.push(n);return o}const value=ref('left').x=ref('right').x=42;return {events,value}`,
  `let a,b;a=b=function(){};return [a.name,b.name]`,
  `let a,b;a=b=class{};return [a.name,b.name]`,
  `let a,b;const value=a=({x:b}={x:42});return [a,b,value]`,
  `let a=1,b=2;try{a=b=(()=>{throw Error('stop')})()}catch{}return [a,b]`,
  `let caught=false;try{eval('let a,b;a=b=;')}catch(e){caught=e instanceof SyntaxError}let a,b;return [caught,a=b=42,a,b]`,
  `let a,b;a=b=()=>42;return [a.name,b.name,a()]`,
  `let a,b;a=b=async()=>42;return [a.name,b.name]`,
  `function* f(){let a,b;a=b=yield 7;return [a,b]}const g=f();return [g.next(),g.next(42)]`,
  `let a,b;const x=a=b=true?42:7;return [a,b,x]`,
  `let a,b;const x=a=b=(3,42);return [a,b,x]`,
  `let a=0,b=0,c=1;const x=a=b ||= c+=41;return [a,b,c,x]`,
  `let a,b=null,c;const x=a=b??=c=42;return [a,b,c,x]`,
  `let a,b=1,c;const x=a=b&&=c=42;return [a,b,c,x]`,
  `class C{#x=1;run(){let a;return a=this.#x=42}}return new C().run()`,
  `class B{set x(v){this.value=v}}class C extends B{run(){let a;return a=super.x=42}}const c=new C;return [c.run(),c.value]`,
  `let a=1;const b=2;let error;try{a=b=42}catch(e){error=e.name}return [a,b,error]`,
  ...['*=','/=','%=','+=','-=','<<=','>>=','>>>=','&=','^=','|=','**='].map(op=>`let a=4,b=2;const result=a${op}b=3;return [a,b,result]`),
]

test('packaged assignment parser preserves native evaluation and error recovery',async({page},info)=>{
  const expected=cases.map(source=>new Function(source)())
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.sdk))
  const observed=await page.evaluate(async cases=>{
    const source='console.log(JSON.stringify(['+cases.map(code=>'(()=>{'+code+'})()').join(',')+']))'
    const kernel=new window.sdk.WorkerKernel({'/main.cjs':source},{experimentalFibers:true,maxBytes:128*1024*1024,timeoutMs:15000})
    try{return await kernel.runModule('/main.cjs',{guestWasm:true,maxBytes:128*1024*1024,timeoutMs:15000})}finally{kernel.close()}
  },cases)
  await info.attach('assignment-semantics.json',{body:JSON.stringify({root,cases,expected,observed}),contentType:'application/json'})
  expect(observed.exitCode,observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout)).toEqual(expected)
})
