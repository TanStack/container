import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

test('builtin cycles share partial exports and failed initialization can retry',()=>{
  const attempts:Record<string,number>={}
  const source:Record<string,string>={
    'node:a':`exports.ready=false;exports.seen=require('node:b').seen;exports.ready=true`,
    'node:b':`exports.seen=require('node:a').ready`,
    'node:bad':`throw Error('failed')`,
  }
  const describe=(path:string)=>JSON.stringify({path,kind:'builtin'})
  const host:{modules?:{load:(path:string)=>any}}={}
  const context={__webContainerHost:host,__moduleDescribe:describe,__moduleResolve:describe,__moduleLoad:()=>({format:'builtin'}),
    __moduleRead:()=>{throw Error('No file read expected')},
    __moduleCompile:(path:string)=>{attempts[path]=(attempts[path]??0)+1;return new Function('exports','require','module','__filename','__dirname',source[path])},
  }
  runInNewContext(readFileSync('src/sandbox/guest-module-hooks.js','utf8')+'\n'+readFileSync('src/sandbox/module-bootstrap.js','utf8'),context)
  const a=host.modules!.load('node:a')
  expect(a).toEqual({ready:true,seen:false})
  expect(host.modules!.load('node:a')).toBe(a)
  expect(attempts['node:a']).toBe(1)
  for(let i=0;i<2;i++)expect(()=>host.modules!.load('node:bad')).toThrow('failed')
  expect(attempts['node:bad']).toBe(2)
})

test('optional binding adaptation runs once on guest CommonJS exports, not builtins',()=>{
  const calls:string[]=[]
  let rejectAdaptation=false
  const originalParse=()=>Promise.resolve('original')
  const nativeParse=()=>Promise.resolve('native')
  const context:any={__webContainerHost:{},
    __moduleDescribe:(path:string)=>JSON.stringify({path,kind:path.startsWith('node:')?'builtin':'commonjs'}),
    __moduleResolve:(path:string)=>JSON.stringify({path,kind:path.startsWith('node:')?'builtin':'commonjs'}),
    __moduleLoad:(path:string)=>path.startsWith('node:')?{format:'builtin'}:{format:'commonjs',source:'exports.parse=globalThis.__testOriginalParse;exports.other=42'},
    __moduleRead:()=>'',
    __moduleCompile:()=>function(exports:any){exports.parse=originalParse;exports.other=42},
    __testOriginalParse:originalParse,
    __moduleAdaptExports:(path:string,exports:any)=>{calls.push(path);if(rejectAdaptation)throw Error('Binding selection failed');if(path==='/binding.cjs')exports.parse=nativeParse},
  }
  runInNewContext(readFileSync('src/sandbox/guest-module-hooks.js','utf8')+'\n'+readFileSync('src/sandbox/module-bootstrap.js','utf8'),context)
  expect(context.__moduleAdaptExports).toBeUndefined()
  const modules=context.__webContainerHost.modules
  const binding=modules.load('/binding.cjs')
  expect(binding.parse).toBe(nativeParse)
  expect(binding.other).toBe(42)
  expect(modules.load('/binding.cjs')).toBe(binding)
  expect(modules.load('/ordinary.cjs').parse).toBe(originalParse)
  expect(modules.load('node:ordinary').parse).toBe(originalParse)
  expect(calls).toEqual(['/binding.cjs','/ordinary.cjs'])
  const main=modules.run('/main.cjs')
  expect(modules.load('/main.cjs')).toBe(main)
  expect(calls).toEqual(['/binding.cjs','/ordinary.cjs','/main.cjs'])
  rejectAdaptation=true
  expect(()=>modules.load('/retry.cjs')).toThrow('Binding selection failed')
  rejectAdaptation=false
  expect(modules.load('/retry.cjs').other).toBe(42)
  expect(calls.filter(path=>path==='/retry.cjs')).toHaveLength(2)
})

test('ordinary CommonJS compilation stays in the guest while builtins use the owner compiler',()=>{
  const compiled:string[]=[]
  const sources:Record<string,string>={
    '/entry.cjs':`exports.value=require('./dependency.cjs').value+1`,
    '/dependency.cjs':`exports.value=require('node:value').value`,
    '/owner.cjs':`throw Error('owner compiler should replace this source')`,
  }
  const describe=(path:string)=>JSON.stringify({path,kind:path.startsWith('node:')?'builtin':'commonjs'})
  const host:{modules?:{load:(path:string)=>any}}={}
  const context={__webContainerHost:host,__moduleDescribe:describe,__moduleHostCompilePaths:['/owner.cjs'],
    __moduleResolve:(specifier:string,importer:string)=>specifier.startsWith('node:')?describe(specifier):describe('/'+specifier.replace(/^\.\//,'')),
    __moduleLoad:(path:string)=>path.startsWith('node:')?{format:'builtin'}:{format:'commonjs',source:sources[path.replace(/^file:\/\//,'')]},
    __moduleRead:()=>{throw Error('No file read expected')},
    __moduleCompile:(path:string)=>{compiled.push(path);return function(exports:any){exports.value=40}},
  }
  runInNewContext(readFileSync('src/sandbox/guest-module-hooks.js','utf8')+'\n'+readFileSync('src/sandbox/module-bootstrap.js','utf8'),context)
  expect(host.modules!.load('/entry.cjs')).toEqual({value:41})
  expect(host.modules!.load('/owner.cjs')).toEqual({value:40})
  expect(compiled).toEqual(['node:value','/owner.cjs'])
  expect((context as any).__moduleHostCompilePaths).toBeUndefined()
})
