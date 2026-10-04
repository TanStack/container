import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {inspectNativeRuntimeSet} from './native-runtime-assets.mjs'

export function nativeRuntimeBuildPlan(root=process.cwd(),output=join(root,'public/native-runtimes')){
  root=resolve(root)
  const descriptor=JSON.parse(readFileSync(join(root,'build-inputs/native-runtime-toolchains.json'),'utf8'))
  assert.equal(descriptor.format,1,'Unsupported native runtime build plan')
  assert.ok(Array.isArray(descriptor.runtimes)&&descriptor.runtimes.length>0,'Native runtime build plan must be nonempty')
  const identities=new Set()
  return descriptor.runtimes.map(runtime=>{
    assert.ok([runtime.vite,runtime.rolldown].every(version=>typeof version==='string'&&/^\d+\.\d+\.\d+$/.test(version)),
      'Native runtime build versions must be exact')
    const id=`vite-${runtime.vite}-rolldown-${runtime.rolldown}`
    assert.ok(!identities.has(id),'Duplicate native runtime build: '+id)
    identities.add(id)
    for(const field of ['vitePackage','rolldownPackage'])
      assert.ok(typeof runtime[field]==='string'&&runtime[field].split('/').every(part=>/^[A-Za-z0-9@._-]+$/.test(part)&&part!=='.'&&part!=='..'),
        'Native compiler package path must be relative: '+field)
    return {id,vite:runtime.vite,rolldown:runtime.rolldown,
      vitePackage:join(root,runtime.vitePackage),rolldownPackage:join(root,runtime.rolldownPackage),
      output:join(resolve(output),id)}
  })
}

export function verifyNativeCompilerPackage(directory,name,version){
  const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'))
  assert.equal(pkg.name,name,'Native compiler package name mismatch')
  assert.equal(pkg.version,version,`Native runtime requires ${name}@${version}`)
}

export function inspectNativeRuntimeBuild(plan){
  const runtimes=inspectNativeRuntimeSet(plan.map(item=>item.output))
  for(const [index,runtime] of runtimes.entries())
    assert.equal(runtime.id,plan[index].id,'Built native compiler does not match the release build plan')
  return runtimes
}
