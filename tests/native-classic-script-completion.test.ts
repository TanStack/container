import {expect,test} from 'vitest'
import {Script,createContext} from 'node:vm'
import {vmCompletionControlSources} from './fixtures/native-vm-completions.mjs'
import {compileClassicScriptCompletion,createClassicScriptCompletionChannel} from '../src/native/classic-script-completion'

test('completion maps stay relative to their input for explicit map composition',()=>{
  const map={version:3,sources:['original.js'],sourcesContent:['42'],names:[],mappings:'AAAA'}
  const source='42\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(map)).toString('base64')
  const compiled=compileClassicScriptCompletion(source,'/app/intermediate.js','completion-channel')
  expect(compiled.map?.sourcesContent).toEqual([source])
  expect(compiled.map?.sources).not.toContain('original.js')
})

test.each(vmCompletionControlSources)('classic completion compiler matches Node for %s',source=>{
  const channel=createClassicScriptCompletionChannel()
  const context=createContext({})
  Object.defineProperty(context,'completion-channel',{value:channel,configurable:true})
  const compiled=compileClassicScriptCompletion(source,'/app/completion.js','completion-channel')
  new Script(compiled.code!).runInContext(context)
  expect(channel.value).toEqual(new Script(source).runInNewContext())
  expect(compiled.map?.sourcesContent).toEqual([source])
})
