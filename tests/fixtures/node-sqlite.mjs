import {DatabaseSync} from 'node:sqlite'
const db=new DatabaseSync(':memory:')
db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, score INTEGER)')
const insert=db.prepare('INSERT INTO items (name, score) VALUES (?, ?)')
const first=insert.run('alpha',21),second=insert.run('beta',42)
const named=db.prepare('SELECT id, name, score FROM items WHERE name = $name').get({$name:'beta'})
const all=db.prepare('SELECT name, score FROM items ORDER BY id').all()
const iterated=[...db.prepare('SELECT name FROM items ORDER BY id').iterate()].map(row=>row.name)
const arrayStatement=db.prepare('SELECT id AS duplicate, score AS duplicate FROM items ORDER BY id')
const sibling=db.prepare('SELECT id AS duplicate, score AS duplicate FROM items ORDER BY id')
const setterReturn=arrayStatement.setReturnArrays(true)
const arrayGet=arrayStatement.get(),arrayAll=arrayStatement.all(),arrayIterated=[...arrayStatement.iterate()]
const independent=sibling.get()
arrayStatement.setReturnArrays(false)
const objectGet=arrayStatement.get(),objectAll=arrayStatement.all(),objectIterated=[...arrayStatement.iterate()]
const toggle=db.prepare('SELECT id FROM items ORDER BY id')
toggle.setReturnArrays(true)
const toggledIterator=toggle.iterate(),firstArray=toggledIterator.next().value
toggle.setReturnArrays(false)
const nextObject=toggledIterator.next().value,toggleDone=toggledIterator.next().done
const beforeFirst=toggle.iterate();toggle.setReturnArrays(true)
const toggledBeforeFirst=[...beforeFirst]
const binary=db.prepare("SELECT x'00ff80' AS bytes, NULL AS nothing_value")
binary.setReturnArrays(true)
const binaryRow=binary.get(),blobAndNull=[Array.from(binaryRow[0]),binaryRow[1]]
const empty=db.prepare('SELECT id FROM items WHERE id = -1');empty.setReturnArrays(true)
const emptyRows={getIsUndefined:empty.get()===undefined,all:empty.all(),iterate:[...empty.iterate()]}
arrayStatement.setReturnArrays(true)
const invalid=[]
for(const value of [undefined,null,0,1,'true',{},[]]){
 let error;try{arrayStatement.setReturnArrays(value)}catch(cause){error={name:cause.name,code:cause.code,message:cause.message}}
 invalid.push({type:value===null?'null':Array.isArray(value)?'array':typeof value,error,row:arrayStatement.get()})
}
const returnArrays={setterReturnsUndefined:setterReturn===undefined,arrayGet,arrayAll,arrayIterated,independent,objectGet,objectAll,objectIterated,firstArray,nextObject,toggleDone,toggledBeforeFirst,blobAndNull,emptyRows,invalid}
db.close()
let closed='';try{insert.get()}catch(error){closed=error.code||error.name}
returnArrays.closed=[]
for(const value of [true,null]){try{arrayStatement.setReturnArrays(value)}catch(error){returnArrays.closed.push({name:error.name,code:error.code,message:error.message})}}
console.log(JSON.stringify({first,second,named,all,iterated,closed,returnArrays}))
