import {expect,test} from 'vitest'
import {promises,lookup} from '../src/vite-browser/node-dns'

test('worker DNS resolves loopback names and addresses without external DNS',async()=>{
  expect(await promises.lookup('localhost')).toEqual({address:'127.0.0.1',family:4})
  expect(await promises.lookup('localhost',{family:6})).toEqual({address:'::1',family:6})
  expect(await promises.lookup('127.0.0.1')).toEqual({address:'127.0.0.1',family:4})
  await expect(promises.lookup('example.com')).rejects.toMatchObject({code:'ENOTFOUND'})
  await new Promise<void>((resolve,reject)=>lookup('localhost',(error,address,family)=>{
    if(error)return reject(error)
    try{expect({address,family}).toEqual({address:'127.0.0.1',family:4});resolve()}
    catch(failure){reject(failure)}
  }))
})
