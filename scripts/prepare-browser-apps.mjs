import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
const root=fileURLToPath(new URL('../fixtures/workloads/',import.meta.url))
const out=fileURLToPath(new URL('../public/workloads/apps/',import.meta.url))
await mkdir(out,{recursive:true})
const {default:svelte}=await import(path.join(root,'node_modules/svelte/compiler/index.js'))
const component='<script>let { initial } = $props(); let count = $state(initial);</script><button onclick={() => count++}>Count {count}</button>'
const apps={
  react:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    function App(){const [count,setCount]=useState(input.value);return React.createElement('button',{onClick:()=>setCount(n=>n+1)},'Count '+count)}
    createRoot(document.getElementById('app')).render(React.createElement(App));`,
  vue:`import {createApp,h,ref} from 'vue';createApp({setup(){const count=ref(input.value);return ()=>h('button',{onClick:()=>count.value++},'Count '+count.value)}}).mount('#app');`,
  solid:`import {createSignal,createEffect} from 'solid-js';import {render} from 'solid-js/web';
    render(()=>{const [count,setCount]=createSignal(input.value);const button=document.createElement('button');
      button.onclick=()=>setCount(n=>n+1);createEffect(()=>button.textContent='Count '+count());return button},document.getElementById('app'));`,
  svelte:`import {mount} from 'svelte';import Component from './Component.js';mount(Component,{target:document.getElementById('app'),props:{initial:input.value}});`,
}
for(const [name,source] of Object.entries(apps)){
  const directory=path.join(root,'generated','app-'+name)
  await mkdir(directory,{recursive:true})
  const files={'main.js':`import input from './input.json';import './style.css';import logo from './logo.svg';
    document.getElementById('logo').src=logo;${source}`,
    'input.json':'{"value":3}', 'style.css':'button { color: rgb(12, 34, 56); padding: 12px; }',
    'logo.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
    'package.json':'{"type":"module","name":"fixture-app"}',
  }
  if(name==='svelte')files['Component.js']=svelte.compile(component,{generate:'client',filename:'Component.svelte'}).js.code
  for(const [file,value] of Object.entries(files))await writeFile(path.join(directory,file),value)
  const discovered=await build({entryPoints:[path.join(directory,'main.js')],absWorkingDir:root,bundle:true,write:false,outdir:'unused',
    platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},loader:{'.svg':'dataurl'},metafile:true,logLevel:'silent'})
  const graph={}
  const packages=new Set()
  const add=async file=>{
    const target=file.startsWith(directory+'/')?'/app/src/'+path.relative(directory,file):'/app/'+path.relative(root,file)
    if(target.includes('/../'))throw Error('App graph escaped fixture directory')
    graph[target]={base64:(await readFile(file)).toString('base64')}
  }
  for(const key of Object.keys(discovered.metafile.inputs)){
    const file=path.resolve(root,key);await add(file)
    for(let p=path.dirname(file);p.startsWith(root)&&p!==root;p=path.dirname(p)){
      try{await add(path.join(p,'package.json'));if(p.includes('/node_modules/'))packages.add(p)}catch(e){if(e.code!=='ENOENT')throw e}
    }
  }
  // Vite and esbuild can select different development/production exports.
  // Keep each discovered package's real JS distributions, not only the branch
  // chosen by the host graph collector.
  async function includeRuntime(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name)
      if(entry.isDirectory()&&!['node_modules','.git'].includes(entry.name))await includeRuntime(file)
      else if(entry.isFile()&&/\.(js|mjs|cjs|json|css)$/.test(entry.name))await add(file)
    }
  }
  for(const pkg of packages)await includeRuntime(pkg)
  graph['/app/package.json']={base64:Buffer.from(files['package.json']).toString('base64')}
  graph['/app/src/main.ts']=graph['/app/src/main.js'];delete graph['/app/src/main.js']
  await writeFile(path.join(out,name+'.json'),JSON.stringify({files:graph,component:name==='svelte'?component:null}))
}
// Fixed trusted browser compiler. Svelte source is compiled again in-browser
// before Vite receives it, host output is used only for graph discovery.
await build({stdin:{contents:`import {compile} from 'svelte/compiler';self.onmessage=e=>{try{self.postMessage({code:compile(e.data,{generate:'client',filename:'Component.svelte'}).js.code})}catch(error){self.postMessage({error:String(error)})}}`,resolveDir:root},
  bundle:true,platform:'browser',format:'esm',outfile:path.join(out,'svelte-compiler.mjs'),logLevel:'silent'})
console.log('Prepared React, Vue, Svelte, and Solid interactive app graphs')
