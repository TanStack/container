// Each probe must perform work and assert its result, not just import a package.
// `seed` changes between runs to catch stale module graphs and stale outputs.
const define = (id, group, scope, source, extra = {}) => ({id, group, scope, source, ...extra})
export const workloadCases = [
  define('zod', 'library', 'parse valid input and reject invalid input', `
    import {z} from 'zod';
    const schema=z.object({value:z.number().int().positive()});
    check(!schema.safeParse({value:'bad'}).success,'invalid input accepted');
    result(schema.parse({value:seed}));`),
  define('lodash', 'library', 'CommonJS collection operations', `
    import _ from 'lodash';
    result(_.mapValues(_.groupBy([seed,seed+1,seed+2],n=>n%2?'odd':'even'),a=>_.sum(a)));`),
  define('date-fns', 'library', 'date arithmetic and formatting', `
    import {addDays,format} from 'date-fns';
    result(format(addDays(new Date(2024,0,1),seed),'yyyy-MM-dd'));`),
  define('query-core', 'library', 'async query, cache read, invalidation, refetch', `
    import {QueryClient} from '@tanstack/query-core';
    const client=new QueryClient({defaultOptions:{queries:{gcTime:Infinity,retry:false}}});
    let calls=0;const queryFn=async()=>{await 0;calls++;return seed};
    await client.fetchQuery({queryKey:['test'],queryFn});
    check(client.getQueryData(['test'])===seed,'missing cached query');
    await client.invalidateQueries({queryKey:['test']});
    const value=await client.fetchQuery({queryKey:['test'],queryFn});
    client.clear();result({value,calls});`),
  define('typescript', 'compiler', 'transpile typed source and execute generated JavaScript', `
    import ts from 'typescript-js';
    const out=ts.transpileModule('const value: number = '+seed+'; value * 2', {compilerOptions:{target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
    check(!out.diagnostics?.length,'diagnostics');result((0,eval)(out.outputText));`),
  define('typescript-check', 'compiler', 'typecheck an in-memory program with a deliberate type error', `
    import ts from 'typescript-js';
    const source='const value: number = "wrong'+seed+'"';
    const host={getSourceFile:(f,v)=>f==='/main.ts'?ts.createSourceFile(f,source,v):undefined,
      getDefaultLibFileName:()=>'',writeFile:()=>{},getCurrentDirectory:()=> '/',getDirectories:()=>[],
      fileExists:f=>f==='/main.ts',readFile:f=>f==='/main.ts'?source:undefined,
      getCanonicalFileName:f=>f,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\\n'};
    const program=ts.createProgram(['/main.ts'],{noLib:true,noEmit:true},host);
    check(program.getSemanticDiagnostics().some(d=>d.code===2322),'missing type error');result(seed);`),
  define('babel', 'compiler', 'Node Babel API transform and execute output', `
    import {transformSync} from '@babel/core';
    const out=transformSync('const value = '+seed+'; value ** 2',{configFile:false,babelrc:false});
    result((0,eval)(out.code));`),
  define('babel-standalone', 'compiler', 'standalone Babel transform and execute output', `
    import Babel from '@babel/standalone';
    const out=Babel.transform('const value: number = '+seed+'; value ** 2',{filename:'value.ts',presets:['typescript']});
    result((0,eval)(out.code));`, {adaptation:'Official standalone distribution'}),
  define('postcss', 'compiler', 'run an async plugin and inspect CSS and source map', `
    import postcss from 'postcss';
    const out=await postcss([{postcssPlugin:'fixture',async Declaration(decl){await 0;if(decl.prop==='width')decl.value=(seed*2)+'px'}}])
      .process('.box { width: '+seed+'px }',{from:'input.css',to:'output.css',map:{inline:false}});
    check(out.css.includes('width: '+seed*2+'px'),'plugin failed');check(out.map.toJSON().sources.length===1,'source map');result(seed*2);`,{execution:'modules'}),
  define('postcss-transform','compiler','run an async CSS plugin without source maps',`
    import postcss from 'postcss';
    const out=await postcss([{postcssPlugin:'fixture',async Declaration(decl){await 0;if(decl.prop==='width')decl.value=(seed*2)+'px'}}])
      .process('.box { width: '+seed+'px }',{from:undefined,map:false});
    check(out.css.includes('width: '+seed*2+'px'),'plugin failed');result(seed*2);`),
  define('svelte-compiler', 'compiler', 'compile component with dynamic text and CSS for client and server', `
    import {compile} from 'svelte/compiler';
    const source='<script>let value = '+seed+';</script><h1>{value}</h1><style>h1{color:red}</style>';
    const server=compile(source,{generate:'server'}),client=compile(source,{generate:'client',css:'external'});
    check(server.js.code.includes('h1')&&client.js.code.includes('h1'),'component output');
    check(client.css.code.includes('color:red'),'CSS output');result(seed);`),
  define('esbuild', 'bundler', 'Node esbuild API bundle a two-module project', `
    import {build,stop} from 'esbuild';
    try{const out=await build({stdin:{contents:'import {value} from "value"; globalThis.answer=value*2'},bundle:true,write:false,format:'iife',
      plugins:[{name:'files',setup(b){b.onResolve({filter:/^value$/},()=>({path:'value',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const value='+seed}))}}]});
    (0,eval)(out.outputFiles[0].text);result(globalThis.answer)}finally{stop()}`),
  define('esbuild-wasm-guest', 'bundler', 'WASM esbuild API inside QuickJS, not a host compiler service', `
    import {build,stop,initialize} from 'esbuild-wasm';
    await initialize({wasmURL:'http://127.0.0.1:4190/workloads/browser/esbuild/esbuild.wasm',worker:false});
    try{const out=await build({stdin:{contents:'globalThis.answer='+seed},write:false});(0,eval)(out.outputFiles[0].text);result(globalThis.answer)}finally{stop()}`, {
      referenceReplace:["await initialize({wasmURL:'http://127.0.0.1:4190/workloads/browser/esbuild/esbuild.wasm',worker:false});",''],
      adaptation:'Browser WASM initialization; Node reference uses its Node initializer',
    }),
  define('rollup', 'bundler', 'Node Rollup API bundle and execute a virtual module graph', `
    import {rollup} from 'rollup';
    const bundle=await rollup({input:'main',plugins:[{name:'fixture',resolveId:id=>id,load:id=>id==='main'?'import {value} from "value"; globalThis.answer=value*2':'export const value='+seed}]});
    try{const out=await bundle.generate({format:'iife'});(0,eval)(out.output[0].code);result(globalThis.answer)}finally{await bundle.close()}`),
  define('rollup-browser-guest', 'bundler', 'browser Rollup distribution inside QuickJS', `
    import {rollup} from '@rollup/browser';
    const bundle=await rollup({input:'main',plugins:[{name:'fixture',resolveId:id=>id,load:()=> 'globalThis.answer='+seed}]});
    try{const out=await bundle.generate({format:'iife'});(0,eval)(out.output[0].code);result(globalThis.answer)}finally{await bundle.close()}`, {adaptation:'Official browser distribution, still executed inside QuickJS',referenceReplace:['@rollup/browser','rollup']}),
  define('webpack', 'bundler', 'compile a file-backed project through webpack', `
    import webpack from 'webpack';import fs from 'node:fs';
    const root=globalThis.__workloadRoot??'';
    fs.writeFileSync(root+'/webpack-input.js','globalThis.answer='+seed);
    await new Promise((resolve,reject)=>{const compiler=webpack({mode:'development',entry:root+'/webpack-input.js',output:{path:root||'/',filename:'webpack-output.js'}});
      compiler.run((error,stats)=>compiler.close(closeError=>error||closeError||stats.hasErrors()?reject(error||closeError||Error(stats.toString())):resolve()))});
    (0,eval)(fs.readFileSync(root+'/webpack-output.js','utf8'));result(globalThis.answer);`,{execution:'modules'}),
  define('webpack-sha256', 'bundler', 'compile a file-backed project with SHA-256 output hashing', `
    import webpack from 'webpack';import fs from 'node:fs';
    const root=globalThis.__workloadRoot??'';
    fs.writeFileSync(root+'/webpack-input.js','globalThis.answer='+seed);
    await new Promise((resolve,reject)=>{const compiler=webpack({mode:'development',entry:root+'/webpack-input.js',output:{path:root||'/',filename:'webpack-output.js',hashFunction:'sha256'}});
      compiler.run((error,stats)=>compiler.close(closeError=>error||closeError||stats.hasErrors()?reject(error||closeError||Error(stats.toString())):resolve()))});
    (0,eval)(fs.readFileSync(root+'/webpack-output.js','utf8'));result(globalThis.answer);`,{
      execution:'modules',adaptation:'Public output.hashFunction setting, default Webpack remains a separate probe',
    }),
  define('react', 'framework', 'React SSR with escaped dynamic content', `
    import React from 'react';import {renderToString} from 'react-dom/server';
    result(renderToString(React.createElement('h1',null,'Value '+seed+' <safe>')));`),
  define('react-node-stream', 'framework', 'React Node streaming SSR into a Node writable', `
    import React from 'react';import {renderToPipeableStream} from 'react-dom/server';
    import {Writable} from 'node:stream';import {finished} from 'node:stream/promises';
    const chunks=[],sink=new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done()}});
    const done=finished(sink);
    const rendering=renderToPipeableStream(React.createElement('h1',null,'Value '+seed+' <safe>'),{
      onAllReady(){rendering.pipe(sink)},onShellError(error){sink.destroy(error)},onError(error){sink.destroy(error)}});
    await done;result(chunks.join(''));`,{execution:'modules'}),
  define('react-edge', 'framework', 'React streaming SSR through its edge entrypoint', `
    import React from 'react';import {renderToReadableStream} from 'react-dom/server.edge';
    const stream=await renderToReadableStream(React.createElement('h1',null,'Value '+seed));
    result(await new Response(stream).text());`, {adaptation:'Explicit React edge server entrypoint'}),
  define('vue', 'framework', 'Vue SSR with escaped dynamic content', `
    import {createSSRApp,h} from 'vue';import {renderToString} from '@vue/server-renderer';
    result(await renderToString(createSSRApp({render:()=>h('h1','Value '+seed+' <safe>')})));`),
  define('solid', 'framework', 'Solid server rendering with a reactive computation', `
    import {renderToString,ssr} from 'solid-js/web/dist/server.js';
    result(renderToString(()=>ssr(['<h1>Value ','</h1>'],seed)));`, {adaptation:'Explicit Solid server entrypoint'}),
  define('svelte', 'framework', 'execute a compiled Svelte server component', `
    import {render} from 'svelte/server';import Component from './Component.js';
    const out=render(Component,{props:{value:seed}});result(out.body??out.html);`, {generatedSvelte:true,adaptation:'Component compiled during fixture preparation, runtime SSR tested here'}),
  define('hono', 'server', 'GET, POST JSON, middleware, and concurrent Fetch requests', `
    import {Hono} from 'hono';
    const app=new Hono();app.use('*',async(c,next)=>{c.set('value',seed);await next();c.header('x-fixture','yes')});
    app.get('/',c=>c.json({value:c.get('value')}));app.post('/',async c=>c.json({value:(await c.req.json()).value+seed}));
    const replies=await Promise.all([app.request('http://example.test/'),app.request('http://example.test/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:2})})]);
    result(await Promise.all(replies.map(async r=>({status:r.status,header:r.headers.get('x-fixture'),body:await r.json()}))));`),
  define('express', 'server', 'Express middleware, listen, HTTP request, and shutdown', `
    import express from 'express';import http from 'node:http';
    const app=express();app.use((req,res,next)=>{res.setHeader('x-fixture','yes');next()});app.get('/',(req,res)=>res.json({value:seed}));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    try{result(await new Promise((resolve,reject)=>{http.get('http://127.0.0.1:'+server.address().port+'/',r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(body)}))}).on('error',reject)}))}
    finally{await new Promise(r=>server.close(r))}`),
  define('sveltekit', 'fullstack', 'SvelteKit response and redirect helpers, not a full application build', `
    import {json,redirect,isRedirect} from '@sveltejs/kit';
    let redirected=false;try{redirect(303,'/next')}catch(e){redirected=isRedirect(e)&&e.status===303}
    check(redirected,'redirect');const r=json({value:seed});result({status:r.status,body:await r.json()});`),
  define('sveltekit-build','fullstack','build a one-route SvelteKit app with its Vite plugin',`
    import {build} from 'vite';import fs from 'node:fs';
    const root=globalThis.__workloadRoot??'/app';fs.writeFileSync(root+'/src/routes/+page.svelte','<h1>Fixture '+seed+'</h1>');
    await build({root,logLevel:'error'});
    const dir=root+'/.svelte-kit/output/server';
    const names=fs.readdirSync(dir,{recursive:true}).filter(name=>name.endsWith('.js'));
    check(names.some(name=>fs.readFileSync(dir+'/'+name,'utf8').includes('Fixture '+seed)),'built route text not found');result(seed);`,{
      referenceProject:'sveltekit',
      files:{'/src/routes/+page.svelte':'<h1>Fixture 3</h1>',
        '/src/app.html':'<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>',
        '/svelte.config.js':'export default {kit:{}}',
        '/vite.config.js':"import {sveltekit} from '@sveltejs/kit/vite';export default {plugins:[sveltekit()]}",
        '/package.json':'{"name":"sandbox-sveltekit-reference","type":"module","private":true,"dependencies":{"cookie":"0.6.0"}}'},
    }),
  define('astro', 'fullstack', 'Astro container renders a server component, not a full build', `
    import {experimental_AstroContainer} from 'astro/container';
    import {createComponent,render} from 'astro/runtime/server/index.js';
    const Component=createComponent(($$result,props)=>render\`<h1>Value \${props.value}</h1>\`);
    const container=await experimental_AstroContainer.create();result(await container.renderToString(Component,{props:{value:seed}}));`),
  define('astro-build','fullstack','build a static Astro page and inspect generated HTML',`
    import {build} from 'astro';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
    const root=globalThis.__workloadRoot??'/app';fs.writeFileSync(root+'/src/pages/index.astro','<h1>Fixture '+seed+'</h1>');
    await build({root:pathToFileURL(root+'/'),configFile:false,logLevel:'error'});
    const html=fs.readFileSync(root+'/dist/index.html','utf8');check(html.includes('Fixture '+seed),'built page text not found');result(seed);`,{
      files:{'/src/pages/index.astro':'<h1>Fixture 3</h1>','/package.json':'{"type":"module","private":true}'},
    }),
  define('next', 'fullstack', 'Next server preparation from a minimal project, no claim of full app support', `
    import next from 'next';
    const app=next({dev:true,dir:globalThis.__workloadRoot??'/app',quiet:true});
    try{await app.prepare();check(typeof app.getRequestHandler()==='function','handler');result(seed)}finally{await app.close()}`, {nodeReference:false}),
  define('eslint', 'developer', 'ESLint detects undefined identifier through Node API', `
    import {Linter} from 'eslint';
    const messages=new Linter().verify('const value='+seed+'; missing(value)',[{languageOptions:{ecmaVersion:2022},rules:{'no-undef':'error'}}]);
    check(messages.some(m=>m.ruleId==='no-undef'),'missing lint error');
    const fixed=new Linter().verifyAndFix('const value='+seed+';',[{rules:{semi:['error','never']}}]);
    check(fixed.fixed&&!fixed.output.endsWith(';')&&fixed.messages.length===0,'autofix failed');result(seed);`,{execution:'modules'}),
  define('prettier', 'developer', 'Prettier standalone with TypeScript and estree plugins', `
    import prettier from 'prettier/standalone';import typescript from 'prettier/plugins/typescript';import estree from 'prettier/plugins/estree';
    result(await prettier.format('const value:number='+seed,{parser:'typescript',plugins:[typescript,estree]}));`, {adaptation:'Official standalone API with explicit plugins'}),
  define('vitest', 'developer', 'start Vitest on a passing test file and close its workers', `
    import {startVitest} from 'vitest/node';import fs from 'node:fs';
    const root=globalThis.__workloadRoot??'/';
    fs.writeFileSync(root+'/fixture.test.js','import {test,expect} from "vitest"; test("value",()=>expect('+seed+' * 2).toBe('+seed*2+'))');
    const ctx=await startVitest('test',[],{root,watch:false,config:false,maxWorkers:1});
    try{check(ctx&&ctx.state.getFiles().length>0&&!ctx.state.getFiles().some(f=>f.result?.state==='fail'),'test runner failed');result(seed)}finally{await ctx?.close()}`),
  define('sqlite', 'runtime', 'SQLite WASM create table, insert, SQL query, close', `
    import init from 'sql.js';
    const SQL=await init();const db=new SQL.Database();
    try{db.run('CREATE TABLE values_table (value INTEGER)');db.run('INSERT INTO values_table VALUES (?)',[seed]);result(db.exec('SELECT value * 2 FROM values_table')[0].values[0][0])}finally{db.close()}`),
  define('python', 'runtime', 'Pyodide execute Python arithmetic and use its filesystem', `
    import {loadPyodide} from 'pyodide';
    const py=await loadPyodide();py.FS.writeFile('/value.txt',String(seed));result(await py.runPythonAsync('int(open("/value.txt").read()) * 2'));`, {nodeReference:false}),
  define('feature-dynamic-import', 'feature', 'literal dynamic import after an edit', `
    const {double}=await import('./lazy.js');result(double(seed));`, {files:{'/lazy.js':'export const double=n=>n*2'}}),
  define('feature-streams', 'feature', 'Web Stream transform and concurrent readers', `
    const results=await Promise.all([seed,seed+1].map(async value=>{
      const stream=new ReadableStream({start(c){c.enqueue(String(value));c.close()}}).pipeThrough(new TransformStream({transform(v,c){c.enqueue(v+'!')}}));
      const reader=stream.getReader();const a=await reader.read(),b=await reader.read();check(b.done,'stream not closed');return a.value;
    }));result(results);`),
  define('feature-cancellation', 'feature', 'AbortSignal carries reason across await', `
    const controller=new AbortController();const seen=[];
    controller.signal.addEventListener('abort',()=>seen.push(controller.signal.reason));
    await 0;controller.abort(seed);check(controller.signal.aborted,'not aborted');result(seen);`),
  define('feature-watch', 'feature', 'filesystem watch observes an edit and closes', `
    import fs from 'node:fs';const root=globalThis.__workloadRoot??'';const file=root+'/watched.txt';
    fs.writeFileSync(file,'before');await new Promise((resolve,reject)=>{const watch=fs.watch(file,()=>{watch.close();resolve()});watch.on('error',reject);setTimeout(()=>fs.writeFileSync(file,String(seed)),10)});
    result(fs.readFileSync(file,'utf8'));`),
]

export function entrySource(fixture) {
  return `import input from './input.json' with {type:'json'};
    const seed=input.value;
    const check=(ok,message)=>{if(!ok)throw Error(message)};
    const result=value=>console.log('__WORKLOAD_RESULT__'+JSON.stringify(value));
    ${fixture.source}`
}
