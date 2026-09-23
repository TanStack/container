export function rollupScaleSource(count) {
  if(!Number.isSafeInteger(count)||count<1||count>10000)throw Error('Invalid module count')
  return `
    import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
    import {dirname,resolve} from 'node:path';
    const count=${count},started=Date.now();
    const {rollup}=await import('./rollup.js');
    const importMs=Date.now()-started;
    mkdirSync('/project');
    const imports=[],values=[];
    for(let n=0;n<count;n++){
      writeFileSync('/project/m'+n+'.js','export const value = '+n+';');
      imports.push('import {value as v'+n+'} from "./m'+n+'.js";');values.push('v'+n);
    }
    writeFileSync('/project/main.js',imports.join('\\n')+'\\nglobalThis.answer=['+values.join(',')+'].reduce((a,b)=>a+b,0)');
    let cache,transforms=0,closed=0;const rows=[];
    const plugin={name:'workspace',
      resolveId(id,importer){return resolve(importer?dirname(importer):'/project',id)},
      async load(id){await Promise.resolve();return readFileSync(id,'utf8')},
      async transform(){await Promise.resolve();transforms++;return null},
      buildStart(){this.emitFile({type:'asset',fileName:'count.txt',source:String(count)})},
      closeBundle(){closed++}
    };
    async function build(label){
      const before=Date.now(),transformed=transforms;
      const bundle=await rollup({input:'/project/main.js',cache,plugins:[plugin]});
      try{
        const {output}=await bundle.generate({format:'iife',sourcemap:true});
        const chunk=output.find(x=>x.type==='chunk');
        if(!chunk.map||!chunk.map.mappings||chunk.map.sources.length!==count+1)throw Error('Incomplete source map');
        if(!output.some(x=>x.type==='asset'&&x.fileName==='count.txt'&&x.source===String(count)))throw Error('Missing plugin asset');
        (0,eval)(chunk.code);cache=bundle.cache;
        const row={label,answer:globalThis.answer,ms:Date.now()-before,transformed:transforms-transformed,modules:cache.modules.length,outputBytes:chunk.code.length};
        rows.push(row);console.log(JSON.stringify({progress:row}));
      }finally{await bundle.close()}
    }
    for(const [label,value] of [['cold',0],['edit',1],['repeat',1],['restore',0]]){
      writeFileSync('/project/m0.js','export const value = '+value+';');await build(label);
    }
    writeFileSync('/project/m0.js','export const value = (');
    let errorCode;try{await build('invalid')}catch(error){errorCode=error.code}
    if(errorCode!=='PARSE_ERROR')throw Error('Missing syntax error');
    writeFileSync('/project/m0.js','export const value = 0;');await build('recovery');
    console.log(JSON.stringify({complete:true,count,importMs,rows,errorCode,closed}));
  `
}
