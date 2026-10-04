import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {nativeExampleHash,readPinnedNativeExamples} from './native-example-sources.mjs'

export function prepareNativeStreamingNodeControl(root=process.cwd()){
  root=resolve(root)
  const pinned=readPinnedNativeExamples(root)
  const example='react/start-streaming-data-from-server-functions'
  const input=pinned.examples.get(example)
  assert.ok(input,'Pinned Streaming example is missing')
  const destination=mkdtempSync(join(tmpdir(),'container-streaming-node-control-'))
  for(const [path,bytes]of Object.entries(input.files)){
    assert.ok(path.startsWith('/project/'),'Unexpected source path')
    const target=join(destination,path.slice('/project/'.length))
    mkdirSync(dirname(target),{recursive:true})
    writeFileSync(target,bytes,{flag:'wx'})
  }
  return {root,destination,example,sourceRevision:input.revision,
    sourceSHA256:input.sourceSHA256,lockSHA256:input.npmLockSHA256,
    examplesManifestSHA256:pinned.manifestSHA256}
}

export function runNativeStreamingNodeControl({root=process.cwd(),run=spawnSync}={}){
  const input=prepareNativeStreamingNodeControl(root)
  const manifest=readFileSync(join(input.destination,'package.json'))
  const result={...input,node:process.version,phase:'install',passed:false}
  console.log('CONTROL_DIRECTORY='+input.destination)
  const execute=args=>{
    const child=run('npm',args,{cwd:input.destination,encoding:'utf8',maxBuffer:32*1024*1024})
    process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'')
    return {exitCode:child.status,signal:child.signal??null,error:child.error?String(child.error):null,
      stdout:child.stdout??'',stderr:child.stderr??''}
  }
  try{
    result.install=execute(['ci','--ignore-scripts','--no-audit','--no-fund'])
    if(result.install.exitCode!==0||result.install.signal||result.install.error)return result
    assert.deepEqual(readFileSync(join(input.destination,'package.json')),manifest,'Control install changed the original manifest')
    assert.equal(nativeExampleHash(readFileSync(join(input.destination,'package-lock.json'))),input.lockSHA256,
      'Control install changed the original lock')
    result.phase='build'
    result.build=execute(['run','build'])
    assert.deepEqual(readFileSync(join(input.destination,'package.json')),manifest,'Control build changed the original manifest')
    assert.equal(nativeExampleHash(readFileSync(join(input.destination,'package-lock.json'))),input.lockSHA256,
      'Control build changed the original lock')
    result.passed=result.build.exitCode===0&&!result.build.signal&&!result.build.error
    if(result.passed)result.phase='complete'
    return result
  }catch(error){result.error=String(error);throw error}
  finally{writeFileSync(join(input.destination,'control-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'})}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.ok(process.argv.length===2||process.argv.length===3,'Usage: node scripts/control-native-streaming-build.mjs [PINNED_FIXTURE_ROOT]')
  const result=runNativeStreamingNodeControl({root:process.argv[2]??process.cwd()})
  process.exitCode=result.passed?0:result.build?.exitCode||result.install?.exitCode||1
}
