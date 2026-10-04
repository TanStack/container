import {expect,it,vi} from 'vitest'
const compiler=vi.hoisted(()=>vi.fn(options=>options))
vi.mock('@rolldown/browser',()=>({rolldown:compiler}))
vi.mock('../src/native/volume-resolver',()=>({volumeResolver:()=>({name:'filesystem-resolver',enforce:'pre'})}))
vi.mock('../src/native/volume-build-loader',()=>({volumeBuildLoader:()=>({name:'filesystem-loader',enforce:'pre'})}))
import {rolldown} from '../src/native/workspace-rolldown'

it('adds workspace file access without replacing caller compiler plugins',()=>{
  const plugin={name:'caller-plugin'}
  const input={input:'/app/config.ts',plugins:[plugin]}
  rolldown(input)
  expect(compiler).toHaveBeenLastCalledWith({input:'/app/config.ts',plugins:[
    plugin,{name:'filesystem-resolver'},{name:'filesystem-loader'},
  ]})
  expect(input.plugins).toEqual([plugin])
})

it('adds workspace file access when internal callers provide no plugins',()=>{
  rolldown({input:'/app/config.ts'})
  expect(compiler).toHaveBeenLastCalledWith({input:'/app/config.ts',plugins:[
    {name:'filesystem-resolver'},{name:'filesystem-loader'},
  ]})
})

it('preserves an existing environment-aware workspace compiler unchanged',()=>{
  const options={input:'/app/server.js',plugins:[{name:'browser-native-volume-build-loader'}]}
  rolldown(options)
  expect(compiler).toHaveBeenLastCalledWith(options)
  expect(compiler.mock.calls.at(-1)?.[0]).toBe(options)
})
