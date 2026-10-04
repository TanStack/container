export async function runDirectoryControl(fs,root){
  const checks=[]
  const check=(name,passed)=>{if(!passed)throw Error(name);checks.push(name)}
  const code=operation=>{try{operation()}catch(error){return error.code}}
  const rejected=async operation=>{try{await operation()}catch(error){return error.code}}
  fs.mkdirSync(root,{recursive:true})
  fs.mkdirSync(root+'/nested')
  fs.writeFileSync(root+'/one','one')
  fs.writeFileSync(root+'/two','two')
  fs.writeFileSync(root+'/nested/child','child')
  fs.symlinkSync('one',root+'/link')
  const expected=['link','nested','one','two']
  const directory=fs.opendirSync(root,{bufferSize:1})
  check('directory path is read-only',directory.path===root&&!Reflect.set(directory,'path','changed'))
  const entries=[]
  for(let entry;(entry=directory.readSync())!==null;)entries.push(entry)
  check('sync reads preserve directory entry constructors and types',
    entries.every(entry=>entry instanceof fs.Dirent)&&
    entries.find(entry=>entry.name==='one')?.isFile()&&
    entries.find(entry=>entry.name==='nested')?.isDirectory()&&
    entries.find(entry=>entry.name==='link')?.isSymbolicLink())
  check('sync iteration returns every entry without following symlinks',JSON.stringify(entries.map(entry=>entry.name).sort())===JSON.stringify(expected))
  check('entry parent paths match the opened path',entries.every(entry=>entry.parentPath===root))
  check('exhausted directory keeps returning null',directory.readSync()===null)
  directory.closeSync()
  check('sync reads and close reject closed handles',code(()=>directory.readSync())==='ERR_DIR_CLOSED'&&code(()=>directory.closeSync())==='ERR_DIR_CLOSED')
  check('promise reads and close reject closed handles',await rejected(()=>directory.read())==='ERR_DIR_CLOSED'&&await rejected(()=>directory.close())==='ERR_DIR_CLOSED')
  check('callback read rejects a closed handle synchronously',code(()=>directory.read(()=>{}))==='ERR_DIR_CLOSED')
  let closeCalled=false
  const closedCallback=new Promise(resolve=>directory.close(error=>{closeCalled=true;resolve(error.code)}))
  check('callback close reports a closed handle asynchronously',!closeCalled&&await closedCallback==='ERR_DIR_CLOSED')

  const callbacks=await new Promise((resolve,reject)=>fs.opendir(root,(error,value)=>error?reject(error):resolve(value)))
  const callbackEntry=await new Promise((resolve,reject)=>callbacks.read((error,value)=>error?reject(error):resolve(value)))
  check('callback open and read return a directory entry',callbackEntry instanceof fs.Dirent)
  await new Promise((resolve,reject)=>callbacks.close(error=>error?reject(error):resolve()))
  check('callback close releases the directory',code(()=>callbacks.readSync())==='ERR_DIR_CLOSED')

  const complete=await fs.promises.opendir(root)
  const names=[]
  for await(const entry of complete)names.push(entry.name)
  check('async iteration reads every entry and closes at exhaustion',JSON.stringify(names.sort())===JSON.stringify(expected)&&code(()=>complete.readSync())==='ERR_DIR_CLOSED')
  const partial=await fs.promises.opendir(root)
  for await(const entry of partial){check('async iteration yields a directory entry',entry instanceof fs.Dirent);break}
  check('breaking iteration closes the directory',code(()=>partial.readSync())==='ERR_DIR_CLOSED')

  const recursive=await fs.promises.opendir(root,{recursive:true,bufferSize:1})
  const descendants=[]
  for await(const entry of recursive)descendants.push(entry.parentPath.slice(root.length)+'/'+entry.name)
  check('recursive iteration includes descendants with their parent paths',
    JSON.stringify(descendants.sort())===JSON.stringify(['/link','/nested','/nested/child','/one','/two']))

  const encoded=fs.opendirSync(root,{encoding:'buffer'})
  check('buffer encoding preserves byte names',encoded.readSync().name instanceof Uint8Array)
  encoded.closeSync()
  const bytes=new TextEncoder().encode(root)
  // Node accepts Buffer paths, not arbitrary typed-array paths.
  const buffer=globalThis.Buffer.from(bytes)
  const buffered=fs.opendirSync(buffer)
  check('buffer paths retain their path and parent path types',globalThis.Buffer.isBuffer(buffered.path)&&globalThis.Buffer.isBuffer(buffered.readSync().parentPath))
  buffered.closeSync()

  const pending=await fs.promises.opendir(root,{bufferSize:1})
  const reading=pending.read()
  check('sync work rejects a concurrent asynchronous read',code(()=>pending.readSync())==='ERR_DIR_CONCURRENT_OPERATION'&&code(()=>pending.closeSync())==='ERR_DIR_CONCURRENT_OPERATION')
  const closing=pending.close()
  check('queued asynchronous close waits for the pending read',(await reading) instanceof fs.Dirent)
  await closing
  check('queued close leaves the directory closed',code(()=>pending.readSync())==='ERR_DIR_CLOSED')

  const cached=fs.opendirSync(root,{bufferSize:32})
  const first=cached.readSync(),second=cached.read(),third=cached.readSync()
  cached.closeSync()
  const secondEntry=await second
  check('buffered async reads consume entries before later sync reads',
    new Set([first.name,secondEntry.name,third.name]).size===3)
  check('closing a buffered handle preserves its pending read result',secondEntry instanceof fs.Dirent)

  const queued=fs.opendirSync(root,{bufferSize:1})
  const reads=Array.from({length:5},()=>queued.read())
  const queuedClose=queued.close()
  const readEntries=await Promise.all(reads)
  await queuedClose
  check('queued reads keep their order and reach end before queued close',
    readEntries.filter(Boolean).length===4&&readEntries[4]===null&&new Set(readEntries.filter(Boolean).map(entry=>entry.name)).size===4)

  const disposed=await fs.promises.opendir(root)
  await disposed[Symbol.asyncDispose]();await disposed[Symbol.asyncDispose]()
  const syncDisposed=fs.opendirSync(root)
  syncDisposed[Symbol.dispose]();syncDisposed[Symbol.dispose]()
  check('explicit disposal is safe after an earlier disposal',code(()=>disposed.readSync())==='ERR_DIR_CLOSED'&&code(()=>syncDisposed.readSync())==='ERR_DIR_CLOSED')
  check('open errors retain filesystem codes',code(()=>fs.opendirSync(root+'/missing'))==='ENOENT'&&code(()=>fs.opendirSync(root+'/one'))==='ENOTDIR')
  check('invalid buffer sizes are rejected',code(()=>fs.opendirSync(root,{bufferSize:0}))==='ERR_OUT_OF_RANGE'&&code(()=>fs.opendirSync(root,{bufferSize:'1'}))==='ERR_INVALID_ARG_TYPE')
  return {checks,passed:true}
}
