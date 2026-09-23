// Reproduce the bundled watcher's root-directory bookkeeping in Node without
// scanning the host root or opening an HTTP/WebSocket listener.
import {createServer} from 'vite'
import {Readable} from 'node:stream'
import {createServer as createHTTPServer} from 'node:http'
import assert from 'node:assert/strict'
import {basename} from 'node:path'

const server=await createServer({
  root:process.cwd(),configFile:false,
  server:{middlewareMode:true,hmr:{server:createHTTPServer()},watch:{ignored:()=>true}},
  optimizeDeps:{noDiscovery:true,include:[]},
})
const Watcher=server.watcher.constructor
await server.close()
const watcher=new Watcher({ignoreInitial:true,useFsEvents:false})
try{
  const probe=async path=>{
    const names=path==='/'?[basename(path),'a.js','b.js']:['a.js','b.js']
    const directory=watcher._getWatchedDir(path)
    for(const name of names)directory.add(name)
    watcher._readdirp=()=>Readable.from(['a.js','b.js'].map(path=>({path,stats:{isSymbolicLink:()=>false}})))
    const removals=[]
    watcher._remove=(directory,item)=>removals.push({directory,item})
    await watcher._nodeFsHandler._handleRead(path,false,{path,hasGlob:false,filterPath:()=>true},undefined,path,0)
    return removals
  }
  const rootRemovals=await probe('/')
  const projectRemovals=await probe('/project')
  assert.deepEqual(rootRemovals,[{directory:'/',item:''}])
  assert.deepEqual(projectRemovals,[])
  console.log(JSON.stringify({node:process.version,rootBasename:basename('/'),projectBasename:basename('/project'),rootRemovals,projectRemovals},null,2))
}finally{await watcher.close()}
