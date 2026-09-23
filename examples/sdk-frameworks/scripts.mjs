export function withExampleTests(files,kind){
  const manifest=JSON.parse(files['/project/package.json'])
  manifest.scripts={...manifest.scripts,test:'node project.test.mjs'}
  const test=kind==='vite'
    ? `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {message} from './message.js';
test('message is nonempty text',()=>{assert.equal(typeof message,'string');assert.ok(message.trim().length>0,'Message must not be empty')});
`
    : `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
test('running Start app serves its home page',async()=>{
  const response=await new Promise((resolve,reject)=>{
    const request=get('http://localhost:8521/',response=>{
      let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);
      response.on('end',()=>resolve({status:response.statusCode,body}));response.on('error',reject);
    });request.on('error',reject);
  });
  assert.equal(response.status,200);
  assert.match(response.body,/id="start-count"/);
  assert.match(response.body,/id="server-call"/);
});
`
  return {...files,'/project/package.json':JSON.stringify(manifest,null,2)+'\n','/project/project.test.mjs':test}
}

export async function readScripts(session){
  const manifest=JSON.parse((await session.read({path:'/project/package.json'})).text)
  return Object.fromEntries(Object.entries(manifest.scripts??{}).filter(([,value])=>typeof value==='string'&&value.trim()))
}

export async function writeChangedSource(session,path,text){
  if((await session.read({path})).text===text)return false
  await session.write({path,text})
  return true
}

export async function saveProject({session,path,text,key,stop,store,close}){
  await stop()
  const changed=await writeChangedSource(session,path,text)
  await store(key,await session.snapshot({encoding:'binary'}))
  await close()
  return {changed}
}

export async function runProjectScript(session,name,runShell){
  const scripts=await readScripts(session)
  if(!Object.hasOwn(scripts,name))throw Error('No package script named '+name)
  return runShell(session.kernel,scripts[name],{cwd:'/project',writable:true,timeoutMs:30000})
}
