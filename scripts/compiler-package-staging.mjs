import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync} from 'node:fs'
import {join,resolve} from 'node:path'

export function compilerPackageInventory(directory){
  const files=[]
  function visit(prefix=''){
    for(const name of readdirSync(join(directory,prefix)).sort()){
      const path=prefix?prefix+'/'+name:name,absolute=join(directory,path),stat=lstatSync(absolute)
      assert.ok(!stat.isSymbolicLink(),'Compiler package contains a symbolic link: '+path)
      if(stat.isDirectory())visit(path)
      else{
        assert.ok(stat.isFile(),'Compiler package contains an unsupported entry: '+path)
        const bytes=readFileSync(absolute)
        files.push({path,mode:stat.mode&0o111?0o755:0o644,bytes:bytes.length,
          sha256:createHash('sha256').update(bytes).digest('hex')})
      }
    }
  }
  assert.ok(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink(),'Invalid compiler package directory')
  visit()
  assert.ok(files.length,'Compiler package cannot be empty')
  return files
}

// A stable physical layout preserves esbuild's own package resolution, browser
// mappings and loaders. Content-addressed inputs never overwrite earlier data.
export function stageCompilerPackage(directory,projectRoot){
  const inventory=compilerPackageInventory(directory)
  const sha256=createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
  const root=realpathSync(resolve(projectRoot))
  let cache=root
  for(const name of ['.toolchains','compiler-inputs']){
    cache=join(cache,name)
    if(!existsSync(cache))mkdirSync(cache)
    const stat=lstatSync(cache)
    assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Invalid compiler input cache directory: '+cache)
  }
  const target=join(cache,sha256),packageRoot=join(target,'package')
  if(!existsSync(target)){
    const staging=mkdtempSync(join(cache,'.staging-'))
    cpSync(directory,join(staging,'package'),{recursive:true,errorOnExist:true,force:false})
    assert.deepEqual(compilerPackageInventory(join(staging,'package')),inventory,'Compiler inputs changed while staging')
    try{renameSync(staging,target)}catch(error){
      if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error
      // Another build may publish the same immutable input tree first.
    }
  }
  const stat=lstatSync(target)
  assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Invalid staged compiler directory')
  assert.deepEqual(readdirSync(target),['package'],'Staged compiler directory contains unexpected entries')
  assert.deepEqual(compilerPackageInventory(packageRoot),inventory,'Staged compiler inputs changed')
  return {packageRoot,sha256,files:inventory.length}
}
