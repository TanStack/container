import {spawnSync} from 'node:child_process'
import {expect,test} from 'vitest'

test('native Node distinguishes owner exit from individual worker termination',()=>{
  for(const ownerExit of [true,false]){
    const source=`const {Worker}=require('node:worker_threads');
      const worker=new Worker('setInterval(()=>{},1000)',{eval:true});
      worker.on('exit',()=>console.log('child exit'));
      worker.once('online',async()=>{
        if(${ownerExit})process.exit(0);
        else await worker.terminate();
      });`
    const result=spawnSync(process.execPath,['-e',source],{encoding:'utf8',timeout:5000})
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(ownerExit?'':'child exit\n')
  }
})
