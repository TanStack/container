import {expect,test} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'

const require=createRequire(import.meta.url)
test('synchronous in-memory facade uses a namespace prepared before construction',async()=>{
  const init=require('../fixtures/workloads/node_modules/sql.js/dist/sql-wasm.js')
  const SQL=await init({wasmBinary:readFileSync('fixtures/workloads/node_modules/sql.js/dist/sql-wasm.wasm')})
  ;(globalThis as any).__webContainerHost={preparedBuiltins:{sqlite:SQL}}
  // @ts-expect-error Guest JavaScript is exercised directly here.
  const {DatabaseSync}=await import('../src/sandbox/guest-node-sqlite.js')
  const db=new DatabaseSync(':memory:')
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, score INTEGER)')
  const insert=db.prepare('INSERT INTO items (name, score) VALUES (?, ?)')
  expect(insert.run('alpha',21)).toEqual({changes:1,lastInsertRowid:1})
  expect(insert.run('beta',42)).toEqual({changes:1,lastInsertRowid:2})
  expect(db.prepare('SELECT name, score FROM items WHERE name = $name').get({$name:'beta'})).toEqual({name:'beta',score:42})
  expect(db.prepare('SELECT name FROM items ORDER BY id').all()).toEqual([{name:'alpha'},{name:'beta'}])
  expect([...db.prepare('SELECT score FROM items ORDER BY id').iterate()]).toEqual([{score:21},{score:42}])
  for(const method of ['createSession','applyChangeset','aggregate','function','loadExtension','enableLoadExtension'])expect(()=>(db as any)[method]()).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
  for(const method of ['setAllowBareNamedParameters','setReadBigInts'])expect(()=>(insert as any)[method]()).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
  const arrays=db.prepare('SELECT id AS value, name AS value, NULL AS empty FROM items ORDER BY id')
  expect(arrays.setReturnArrays(true)).toBeUndefined()
  expect(arrays.get()).toEqual([1,'alpha',null])
  expect(arrays.all()).toEqual([[1,'alpha',null],[2,'beta',null]])
  expect([...arrays.iterate()]).toEqual([[1,'alpha',null],[2,'beta',null]])
  expect(db.prepare('SELECT name FROM items ORDER BY id').get()).toEqual({name:'alpha'})
  arrays.setReturnArrays(false);expect(arrays.get()).toEqual({value:'alpha',empty:null})
  for(const value of [undefined,null,0,1,'true',{},[]])expect(()=>arrays.setReturnArrays(value)).toThrow(expect.objectContaining({name:'TypeError',code:'ERR_INVALID_ARG_TYPE',message:'The "returnArrays" argument must be a boolean.'}))
  db.close();expect(()=>insert.get()).toThrow(expect.objectContaining({code:'ERR_INVALID_STATE'}))
  expect(()=>arrays.setReturnArrays(true)).toThrow(expect.objectContaining({code:'ERR_INVALID_STATE',message:'statement has been finalized'}))
  expect(()=>new DatabaseSync('/file.db')).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
  expect(()=>new DatabaseSync(':memory:',{readOnly:true})).toThrow(expect.objectContaining({code:'ERR_UNSUPPORTED_OPERATION'}))
})
