import {test,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {runInNewContext} from 'node:vm'

test('generated SQLite preparation supplies a complete mutable CommonJS wrapper',async()=>{
 const artifact=JSON.parse(readFileSync('public/kernel-runtime/builtins.json','utf8'))
 const preparation=artifact.preparations.find((row:{name:string})=>row.name==='sqlite')
 const host={modules:{createRequire},preparedBuiltins:{} as Record<string,any>}
 // SQLite owns its decoder dependency, no optional web API globals required.
 await runInNewContext(`(${preparation.source})()`,{__webContainerHost:host,Buffer,WebAssembly,process,console})
 const db=new host.preparedBuiltins.sqlite.Database()
 try{expect(db.exec('SELECT 42 AS answer')[0].values).toEqual([[42]])}finally{db.close()}
})
