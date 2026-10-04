import {expect,test} from 'vitest'
import {launchConditions,parseLaunchFlags,parseNodeInvocation} from '../src/native/launch-conditions'
test('shares source flags and argument boundaries between Node launch callers',()=>{
  expect(parseNodeInvocation(['--input-type','module','--eval=await 1','arg'])).toEqual({entry:'__native_eval__.cjs',argv:['arg'],execArgv:['--input-type','module','--eval=await 1'],evalSource:'await 1'})
  expect(parseNodeInvocation(['-r','./preload.cjs','-','arg'])).toEqual({entry:'__native_stdin__.cjs',argv:['arg'],execArgv:['-r','./preload.cjs'],stdinSource:true})
  expect(parseNodeInvocation(['--','-script.js','--arg'])).toEqual({entry:'-script.js',argv:['--arg'],execArgv:[]})
  expect(()=>parseNodeInvocation(['--input-type=module','script.js'])).toThrow('--input-type can only be used with eval or stdin')
})
test('parses explicit input modes and rejects missing or unknown modes',()=>{
  expect(parseLaunchFlags(['--input-type=module','-e','await Promise.resolve()'])).toEqual({conditions:[],preloads:[],inputType:'module'})
  expect(parseLaunchFlags(['--input-type','commonjs'])).toEqual({conditions:[],preloads:[],inputType:'commonjs'})
  for(const flags of [['--input-type'],['--input-type=json']])expect(()=>parseLaunchFlags(flags)).toThrow('Unsupported Node input type')
})
test('parses repeated condition flags without dropping unknown flags',()=>{
  expect(launchConditions(['--conditions','node','--conditions=development','-C','node'])).toEqual(['node','development'])
  expect(()=>launchConditions(['--conditions'])).toThrow()
  expect(()=>launchConditions(['--inspect'])).toThrow()
})
test('preserves ordered CommonJS preloads and accepts the implemented import-meta resolver flag',()=>{
  expect(parseLaunchFlags(['--experimental-import-meta-resolve','-r','./first.cjs','--conditions=test',
    '--require=/app/second.cjs','--require','third'])).toEqual({conditions:['test'],preloads:['./first.cjs','/app/second.cjs','third']})
  for(const flags of [['--require'],['--require='],['-r','--inspect'],['--import'],['--import=']])
    expect(()=>parseLaunchFlags(flags)).toThrow('Unsupported or incomplete Node launch flag')
})
test('preserves ESM preload forms and script argument boundaries',()=>{
  expect(parseLaunchFlags(['--import','./first.mjs','--require=./require.cjs','--import=file:///app/second.mjs']))
    .toEqual({conditions:[],preloads:['./require.cjs'],imports:['./first.mjs','file:///app/second.mjs']})
  expect(parseNodeInvocation(['--import','./first.mjs','entry.cjs','argument']))
    .toEqual({entry:'entry.cjs',argv:['argument'],execArgv:['--import','./first.mjs']})
})
