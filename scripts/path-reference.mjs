import { readFile, writeFile, mkdir } from 'node:fs/promises'
import vm from 'node:vm'
import path from 'node:path'
import { createHash } from 'node:crypto'
const root = new URL('../node_modules/path-browserify/', import.meta.url)
const metadata = JSON.parse(
  await readFile(new URL('package.json', root), 'utf8'),
)
if (metadata.version !== '1.0.1')
  throw new Error(
    'Review upstream test changes before changing the pinned path reference',
  )
// A strict synchronous adapter for these selected tape methods, not the tape runner.
const adapter = `
const results={assertions:0,tests:0,skipped:[]};
function check(ok,message){results.assertions++;if(!ok)throw new Error(message||'Upstream assertion failed')}
function tape(name,options,fn){
  if(typeof options==='function'){fn=options;options={}};
  if(options.skip){results.skipped.push(name);return};
  results.tests++;let ended=false;
  fn({strictEqual:(a,b)=>check(a===b,name+': '+String(a)+' !== '+String(b)),
    throws:(fn,expected)=>{let error;try{fn()}catch(e){error=e};check(error&&error instanceof expected,name+': expected '+expected.name)},
    end:()=>{ended=true}});
  if(!ended)throw new Error('Test did not finish: '+name);
}
tape.results=results;module.exports=tape;
`
const adapterContext = { module: { exports: {} } }
vm.runInNewContext(adapter, adapterContext)
const tape = adapterContext.module.exports
// Keep Node's real Windows helpers available. Some otherwise POSIX test groups
// conditionally add Windows assertions when win32 exists.
const posix = path.posix
const files = {
  '/node_modules/tape/package.json': JSON.stringify({
    name: 'tape',
    main: 'index.cjs',
  }),
  '/node_modules/tape/index.cjs': adapter,
  '/upstream/index.js': `module.exports=require('node:path')`,
}
const sources = []
const names = [
  'test-path.js',
  ...[
    'basename',
    'dirname',
    'extname',
    'isabsolute',
    'join',
    'relative',
    'resolve',
    'zero-length-strings',
  ].map((x) => `test-path-${x}.js`),
]
for (const name of names) {
  const source = await readFile(new URL('test/' + name, root), 'utf8')
  sources.push({
    name,
    sha256: createHash('sha256').update(source).digest('hex'),
  })
  vm.runInNewContext(source, {
    require: (id) => {
      if (id === 'tape') return tape
      if (id === '../') return posix
      throw new Error('Unexpected upstream require ' + id)
    },
    __filename: '/upstream/test/' + name,
    process,
    TypeError,
  })
  files['/upstream/test/' + name] =
    `var __filename=${JSON.stringify('/upstream/test/' + name)};var process=require('node:process');\n` +
    source
}
files['/main.cjs'] =
  names.map((name) => `require('./upstream/test/${name}');`).join('\n') +
  `\nconsole.log(JSON.stringify(require('tape').results));`
const destination = new URL(
  '../public/feasibility/path-upstream.json',
  import.meta.url,
)
await mkdir(new URL('.', destination), { recursive: true })
await writeFile(
  destination,
  JSON.stringify(
    {
      package: 'path-browserify',
      version: metadata.version,
      license: await readFile(new URL('LICENSE', root), 'utf8'),
      sources,
      expected: tape.results,
      files,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  `Pinned upstream path subset: ${tape.results.assertions} assertions, ${tape.results.skipped.length} explicit skipped groups`,
)
