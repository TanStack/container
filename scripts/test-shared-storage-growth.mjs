import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'

const source=readFileSync('src/sandbox/guest-shared-storage.c','utf8')
const marker='static void qts_install_shared_storage(JSRuntime *runtime) {'
const end=source.indexOf(marker)
if(end<0||source.indexOf(marker,end+1)!==-1)throw Error('Storage/QuickJS wrapper boundary changed')
const directory=mkdtempSync(join(tmpdir(),'shared-storage-growth-'))
// Keep the storage implementation verbatim. JS wrapper methods are not part of
// this allocator unit test, and the real browser suites cover their ownership.
writeFileSync(join(directory,'shared-storage-under-test.c'),source.slice(0,end))
const executable=join(directory,'shared-storage-growth')
for(const [command,args] of [
  [process.env.CC??'cc',['-std=c11','-O2','-Wall','-Wextra','-Wno-unused-function','-Wno-unused-variable','-I',directory,'-I',resolve('src/sandbox'),resolve('tests/native/shared-storage-growth.c'),'-o',executable]],
  [executable,[]],
  [executable,['reservation']],
]){
  const result=spawnSync(command,args,{encoding:'utf8',timeout:15000})
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'')
  if(result.status!==0)throw result.error??Error(`${command} failed (${result.status}, ${result.signal})`)
}
