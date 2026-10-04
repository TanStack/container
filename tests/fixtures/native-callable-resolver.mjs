export async function probeCallableResolver(viteResolvePlugin, {root, report = () => {}, timeoutMs = 5000,
  readPackage}) {
  const importer = root + '/fixture/index.js', expected = root + '/fixture/target.js'
  const events = [], results = [], failures = []
  let callbacks = 0
  const record = row => { events.push(row); if(events.length > 128)events.shift(); report({events, results, callbacks, failures}) }
  const plugin = viteResolvePlugin({
    resolveOptions: {isBuild:false, isProduction:false, asSrc:true, preferRelative:false,
      root, scan:false, mainFields:['module','main'], conditions:['node','import','development'],
      externalConditions:['node'], extensions:['.js','.mjs'], tryIndex:true,
      preserveSymlinks:false, tsconfigPaths:false},
    environmentConsumer:'server', environmentName:'ssr', builtins:[], external:[], noExternal:true, dedupe:[],
    resolveSubpathImports(id, from, isRequire, scan) {
      callbacks++
      record({phase:'callback', id, importer:from, isRequire, scan})
      const target = readPackage ? JSON.parse(readPackage(root + '/fixture/package.json')).imports?.[id] :
        id === '#target' ? './target.js' : undefined
      record({phase:'callback-return', id, target})
      return target
    },
  })
  const hook = typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId?.handler
  if(typeof hook !== 'function')throw Error('Missing callable resolveId hook')
  const resolve = async (label, id) => {
    record({phase:'call', label, id})
    let timer
    try {
      const result = await Promise.race([
        Reflect.apply(hook, {}, [id, importer, {kind:'dynamic-import',isEntry:false,attributes:{}}]),
        new Promise((_, reject) => {timer=setTimeout(()=>reject(Error('Callable resolver timed out: '+label)),timeoutMs)}),
      ])
      if(result?.id !== expected)failures.push({label,error:'Unexpected resolution: '+JSON.stringify(result)})
      const row = {label, id, resolved:result?.id === expected ? 'fixture/target.js' : result?.id ?? null, external:result?.external ?? false}
      results.push(row); record({phase:'fulfilled', ...row})
    } catch(error) {failures.push({label,error:String(error)});record({phase:'rejected',label,error:String(error)})}
    finally {clearTimeout(timer)}
  }
  await resolve('relative','./target.js')
  if(callbacks !== 0)failures.push({label:'relative',error:'Relative import unexpectedly used the private-import callback'})
  await resolve('private','#target')
  if(callbacks !== 1)failures.push({label:'private',error:'Private import callback count did not match'})
  await Promise.all(Array.from({length:16},(_,index)=>resolve('concurrent-'+index,index%2?'#target':'./target.js')))
  if(callbacks !== 9)failures.push({label:'concurrent',error:'Concurrent private import callback count did not match'})
  return {results, callbacks, events, failures}
}
