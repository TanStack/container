import input from './input.json' with {type:'json'};
    const seed=input.value;
    const check=(ok,message)=>{if(!ok)throw Error(message)};
    const result=value=>console.log('__WORKLOAD_RESULT__'+JSON.stringify(value));
    
    import {build} from 'vite';import fs from 'node:fs';
    const root=globalThis.__workloadRoot??'/app';fs.writeFileSync(root+'/src/routes/+page.svelte','<h1>Fixture '+seed+'</h1>');
    await build({root,logLevel:'error'});
    const dir=root+'/.svelte-kit/output/server';
    const names=fs.readdirSync(dir,{recursive:true}).filter(name=>name.endsWith('.js'));
    check(names.some(name=>fs.readFileSync(dir+'/'+name,'utf8').includes('Fixture '+seed)),'built route text not found');result(seed);