import {expect,test} from 'vitest'
import {Script,createContext} from 'node:vm'
import {compileSourceCompletion} from '../src/native/source-completion'
import {createClassicScriptCompletionChannel} from '../src/native/classic-script-completion'
import {vmCompletionControlSources,nestedVMCompletionSources} from './fixtures/native-vm-completions.mjs'

test.each([...vmCompletionControlSources,...nestedVMCompletionSources,'1,2,3','(1,2,3)','if(true)1,2;else 3','while(false)1,2','try{1,2}finally{3,4}',
  '"\\u0061"','"a\\nb"','"\\x61"','"\\u{1F600}"','"use strict";"\\u0061"',
  'try{42}finally{try{7}finally{9}}','try{42}finally{while(false)7}',
  '"a"// final comment','42// final comment','if(true)(1,2)// comment',
])('local completion edits match Node for %s',source=>{
  const channel=createClassicScriptCompletionChannel()
  const context=createContext({})
  Object.defineProperty(context,'completion-channel',{value:channel,configurable:true})
  const compiled=compileSourceCompletion(source,'/app/completion.js','completion-channel')
  new Script(compiled.code).runInContext(context)
  expect(channel.value).toEqual(new Script(source).runInNewContext())
  expect(compiled.map.sourcesContent).toEqual([source])
})
test('completion instrumentation leaves function spelling and comments intact',()=>{
  const source='(async function own( value ) { /* keep comment */ return value })'
  const channel=createClassicScriptCompletionChannel()
  const context=createContext({})
  Object.defineProperty(context,'completion-channel',{value:channel})
  new Script(compileSourceCompletion(source,'/app/source.js','completion-channel').code).runInContext(context)
  expect((channel.value as Function).toString()).toBe(new Script(source).runInNewContext().toString())
})
