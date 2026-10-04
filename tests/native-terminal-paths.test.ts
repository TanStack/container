import {test,expect} from 'vitest'
import {toShellDirectory,fromShellDirectory} from '../src/native/terminal-paths'
test('project paths translate and scratch paths round trip',()=>{
  for(const [container,shell] of [['/app','/project'],['/app/src','/project/src'],['/tmp','/tmp'],['/tmp/task','/tmp/task']]){
    expect(toShellDirectory(container!)).toBe(shell)
    expect(fromShellDirectory(shell!)).toBe(container)
  }
})
test('directory boundaries reject roots, prefixes and normalized escapes',()=>{
  for(const cwd of ['/','/etc','/tmp-other','/tmp/../../etc','relative','/tmp/\0']){
    expect(()=>toShellDirectory(cwd)).toThrow()
    expect(()=>fromShellDirectory(cwd)).toThrow()
  }
  expect(()=>toShellDirectory('/app-other')).toThrow()
  expect(()=>fromShellDirectory('/project-other')).toThrow()
})
