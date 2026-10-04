import test from 'node:test'
import assert from 'node:assert/strict'
import {fs as constructors} from 'memfs'
import {createNativeFilesystemClientApi} from '../src/native/filesystem-client-api.mjs'
import {withNativeFilesystemService} from './fixtures/native-filesystem-service.mjs'

for(const codecVersion of ['1.1.4','1.2.4'])test(`remote stat dates retain Node methods, codec ${codecVersion}`,{timeout:15000},async()=>{
  await withNativeFilesystemService(async({connect,inspect})=>{
    const connection=connect('client')
    const client=createNativeFilesystemClientApi(connection.fs,constructors,connection.endpoint.port)
    const {fs}=client
    try{
      fs.writeFileSync('/app/input.txt','content')
      fs.symlinkSync('input.txt','/app/link')
      fs.utimesSync('/app/input.txt',new Date(100000),new Date(200000))
      const fd=fs.openSync('/app/input.txt','r')
      const handle=await fs.promises.open('/app/input.txt','r')
      try{
        for(const options of [undefined,{bigint:true}]){
          const stats=[fs.statSync('/app/input.txt',options),fs.lstatSync('/app/link',options),fs.fstatSync(fd,options),
            await fs.promises.stat('/app/input.txt',options),await fs.promises.lstat('/app/link',options),await handle.stat(options),
            await new Promise((resolve,reject)=>fs.stat('/app/input.txt',options,(error,value)=>error?reject(error):resolve(value)))]
          for(const stat of stats){
            assert.ok(stat instanceof constructors.Stats)
            for(const name of ['atime','mtime','ctime','birthtime']){
              assert.ok(stat[name] instanceof Date,`${name} must be a Date`)
              assert.equal(stat[name].getTime(),Number(stat[name+'Ms']))
              assert.equal(stat[name].toJSON(),new Date(Number(stat[name+'Ms'])).toJSON())
              assert.equal(JSON.parse(JSON.stringify(stat,(_key,value)=>typeof value==='bigint'?String(value):value))[name],stat[name].toJSON())
            }
          }
          assert.equal(stats[0].mtime.getTime(),200000)
          assert.equal(stats[0].isFile(),true)
          assert.equal(stats[1].isSymbolicLink(),true)
          assert.equal(typeof stats[0].size,options?.bigint?'bigint':'number')
          assert.equal(stats[0].size,options?.bigint?7n:7)
        }
        assert.equal(fs.statSync('/app/missing',{throwIfNoEntry:false}),undefined)
        assert.throws(()=>fs.statSync('/app/missing'),error=>error.code==='ENOENT')
      }finally{fs.closeSync(fd);await handle.close()}
      assert.equal((await inspect()).descriptors,0)
    }finally{client.dispose()}
  },{codecVersion})
})
