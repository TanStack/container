import {Buffer} from 'buffer'
import path from 'path-browserify'
import {createNativeFilesystemAsyncApi} from './filesystem-async-api.mjs'
import {createNativeFilesystemWatchClient} from './filesystem-watch-client.mjs'
import {createNativeDirectoryApi} from './filesystem-directory-api.mjs'
import {WRITE_FILE_WITH_PARENTS} from './filesystem-write-protocol.mjs'

const onePath=new Set(['accessSync','appendFileSync','chmodSync','chownSync','existsSync',
  'lchmodSync','lchownSync','lstatSync','lutimesSync','mkdirSync','mkdtempSync','openSync',
  'opendirSync','readFileSync','readdirSync','readlinkSync','realpathSync','rmSync','rmdirSync',
  'statSync','statfsSync','truncateSync','unlinkSync','utimesSync','writeFileSync'])
const twoPaths=new Set(['copyFileSync','cpSync','linkSync','renameSync'])

function filename(value,cwd,relative=true){
  if(value instanceof URL){
    if(value.protocol!=='file:')throw Object.assign(new TypeError('File URL required'),{code:'ERR_INVALID_URL_SCHEME'})
    if(value.hostname&&value.hostname!=='localhost')throw Object.assign(new TypeError('Local file URL required'),{code:'ERR_INVALID_FILE_URL_HOST'})
    if(/%2f|%5c/i.test(value.pathname))throw Object.assign(new TypeError('Encoded path separator in file URL'),{code:'ERR_INVALID_FILE_URL_PATH'})
    value=decodeURIComponent(value.pathname)
  }else if(Buffer.isBuffer(value))value=value.toString('utf8')
  if(typeof value!=='string')return value
  if(value.includes('\0'))throw Object.assign(new TypeError('File path contains a null byte'),{code:'ERR_INVALID_ARG_VALUE'})
  if(!relative||path.isAbsolute(value))return value
  const directory=cwd()
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0'))throw TypeError('Filesystem cwd must be an absolute path')
  return path.resolve(directory,value)
}

// The provider holds public methods and local API lifetimes, never file bytes,
// directory inodes, descriptor positions or a writable fallback Volume.
export function createNativeFilesystemClientApi(filesystem,constructors,port,
  {cwd=()=>'/app',createAsyncResource,keepAlive,...watchOptions}={}){
  if(typeof cwd!=='function')throw TypeError('Filesystem cwd must be a function')
  const sync={}
  for(const name of Object.keys(constructors)){
    // Directory handles need an owner-side handle protocol, not serialization
    // of an object that captures the owner's filesystem implementation.
    if(!name.endsWith('Sync')||name==='opendirSync'||typeof constructors[name]!=='function')continue
    sync[name]=(...args)=>{
      args=args.slice()
      if(onePath.has(name))args[0]=filename(args[0],cwd)
      else if(twoPaths.has(name)){args[0]=filename(args[0],cwd);args[1]=filename(args[1],cwd)}
      else if(name==='symlinkSync'){
        // A relative link target is data, not a path resolved against cwd.
        args[0]=filename(args[0],cwd,false);args[1]=filename(args[1],cwd)
      }else if(name==='globSync'){
        args[1]={...args[1],cwd:filename(args[1]?.cwd??cwd(),cwd)}
      }
      return filesystem[name](...args)
    }
  }
  for(const name of ['constants','Stats','Dirent']){
    if(constructors[name]===undefined)throw TypeError('Missing filesystem constructor: '+name)
    sync[name]=constructors[name]
  }
  if(typeof sync.realpathSync!=='function')throw TypeError('Missing filesystem realpathSync operation')
  sync.realpathSync.native=sync.realpathSync
  const directories=createNativeDirectoryApi(filesystem,{createAsyncResource,keepAlive,
    normalizePath:target=>filename(target,cwd),
    displayPath:target=>Buffer.isBuffer(target)?target:filename(target,cwd,false)})
  sync.opendirSync=directories.opendirSync;sync.Dir=directories.Dir
  const async=createNativeFilesystemAsyncApi(sync,{createAsyncResource,keepAlive})
  const watches=createNativeFilesystemWatchClient(filesystem,port,{...watchOptions,createAsyncResource,keepAlive})
  const watch=(target,...args)=>watches.watch(filename(target,cwd),...args)
  const vol={...sync,watch},fs={...vol,...async.callbacks,promises:async.promises,FSWatcher:watches.FSWatcher}
  // Container file writes can create parents and check links in one owner call.
  // Keep this on the internal volume, not the public node:fs facade.
  vol.writeFileWithParentsSync=(target,contents,options)=>
    filesystem[WRITE_FILE_WITH_PARENTS](filename(target,cwd),contents,options)
  return {fs,vol,FileHandle:async.FileHandle,inspect:()=>watches.inspect(),inspectDirectories:()=>directories.inspect(),
    dispose(){try{directories.dispose()}finally{watches.dispose()}},
    changedPaths:scope=>filesystem.__tanstackFilesystemChanges(scope)}
}
