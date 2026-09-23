import eventsSource from 'events/events.js?raw'
import {nodeCompatibilityVersion,sandboxVersion} from '../sandbox/runtime-profile'
import nodeCoreSource from './generated/node-core.js?raw'
import performanceSource from '../sandbox/guest-performance.js?raw'
import vmSource from '../sandbox/guest-vm.js?raw'
import vmModulesSource from '../sandbox/guest-vm-modules.js?raw'
import fsConstantsSource from '../sandbox/guest-fs-constants.js?raw'
import fsTypesSource from '../sandbox/guest-fs-types.js?raw'
import fsPathsSource from '../sandbox/guest-fs-paths.js?raw'
import fsCopySource from '../sandbox/guest-fs-cp.js?raw'
import fsWatchSource from '../sandbox/guest-fs-watch.js?raw'
import fsDescriptorsSource from '../sandbox/guest-fs-descriptors.js?raw'
import fsStreamsSource from '../sandbox/guest-fs-streams.js?raw'
import fsMkdtempSource from '../sandbox/guest-fs-mkdtemp.js?raw'
import processStateSource from './guest-process-state.cjs?raw'
import styleTextSource from '../sandbox/guest-style-text.js?raw'
import base64Source from '../sandbox/guest-base64.js?raw'
import cryptoSource from '../sandbox/guest-crypto.js?raw'
import readlineSource from '../sandbox/guest-readline.js?raw'
import ttySource from '../sandbox/guest-tty.js?raw'
import consoleSource from '../sandbox/guest-console.js?raw'
import asyncResourceSource from '../sandbox/guest-async-resource.js?raw'
import ipcCodecSource from '../sandbox/guest-ipc-codec.js?raw'
import ipcChannelSource from '../sandbox/guest-ipc-channel.js?raw'
import nodeMessagePortSource from '../sandbox/guest-node-message-port.js?raw'
import routedPortsSource from '../sandbox/guest-routed-ports.js?raw'
import v8SerializationSource from '../sandbox/guest-v8-serialization.js?raw'
import timersPromisesSource from '../sandbox/guest-timers-promises.js?raw'
import netSource from '../sandbox/guest-net.js?raw'
import dgramSource from '../sandbox/guest-dgram.js?raw'
import httpSource from '../sandbox/guest-http.js?raw'
import http2Source from '../sandbox/guest-http2.js?raw'
import tlsSource from '../sandbox/guest-tls.js?raw'
import httpsSource from '../sandbox/guest-https.js?raw'
import childProcessSource from '../sandbox/guest-child-process.js?raw'
import clusterSource from '../sandbox/guest-cluster.js?raw'
import workerThreadsSource from '../sandbox/guest-worker-threads.js?raw'
import dnsSource from '../sandbox/guest-dns.js?raw'
import zlibSource from '../sandbox/guest-zlib.js?raw'
import zlibBackend from './generated/zlib.js?raw'
import diagnosticsChannelSource from '../sandbox/guest-diagnostics-channel.js?raw'
import streamConsumersSource from '../sandbox/guest-stream-consumers.js?raw'
import nodeTestSource from '../sandbox/guest-node-test.js?raw'
import nodeTestReportersSource from '../sandbox/guest-test-reporters.js?raw'
import replSource from '../sandbox/guest-repl.js?raw'
import bufferExtrasSource from './buffer-extras.js?raw'
import eventsExtrasSource from './events-extras.js?raw'
import nodeSQLiteSource from '../sandbox/guest-node-sqlite.js?raw'
import punycodeSource from '../../node_modules/tr46/node_modules/punycode/punycode.js?raw'
import wasiSource from '../sandbox/guest-wasi.js?raw'
import wasiFilesSource from '../sandbox/guest-wasi-files.js?raw'
import wasiPollSource from '../sandbox/guest-wasi-poll.js?raw'
import domainSource from '../sandbox/guest-domain.js?raw'
import seaSource from '../sandbox/guest-sea.js?raw'
import utilParseArgsSource from '../sandbox/guest-util-parse-args.js?raw'
import utilParseEnvSource from '../sandbox/guest-util-parse-env.js?raw'

const initializeNodeCore=`globalThis.__webContainerHost.nodeCore??=(()=>{const module={exports:{}};const exports=module.exports;${nodeCoreSource}\nreturn module.exports})()`
// node:process initializes the shared implementation before its dependents run.
// Repeating its source in each facade still duplicated parsed bytecode even
// though the runtime cache prevented the extra initializers from executing.
const nodeCore=`import process from 'node:process';globalThis.process=process;const core=globalThis.__webContainerHost.nodeCore;`

const builtinDefinitions: Record<string, string> = {
  'node:sea':seaSource,
  'node:domain':domainSource,
  'node:wasi':wasiSource.replace("import {createWASIFileSystem} from './guest-wasi-files.js'",wasiFilesSource.replace('export function createWASIFileSystem','function createWASIFileSystem')).replace("import {createWASIPoll} from './guest-wasi-poll.js'",wasiPollSource.replace('export function createWASIPoll','function createWASIPoll')),
  'node:test':nodeTestSource,
  'node:test/reporters':nodeTestReportersSource,
  'node:repl':replSource,
  'node:sqlite':nodeSQLiteSource,
  'node:punycode':`const implementation=(()=>{const module={exports:{}};const exports=module.exports;${punycodeSource}\nreturn module.exports})();
    // Node 24 exposes the bundled API version, while the compatible local implementation is newer.
    implementation.version='2.1.0';
    export const {decode,encode,toASCII,toUnicode,ucs2,version}=implementation;export default implementation;`,
  'node:diagnostics_channel':diagnosticsChannelSource,
  'node:stream/consumers':streamConsumersSource,
  'node:v8':`
    ${v8SerializationSource}
    const unavailable=()=>{throw Object.assign(new Error('This runtime is not building a Node startup snapshot'),{code:'ERR_NOT_BUILDING_SNAPSHOT'})};
    // Node 24 exposes the normal-runtime flag as numeric zero.
    export const startupSnapshot=Object.freeze({isBuildingSnapshot:()=>0,addSerializeCallback:unavailable,addDeserializeCallback:unavailable,setDeserializeMainFunction:unavailable});
    export default {startupSnapshot,serialize,deserialize};
  `,
  'node:zlib':`${nodeCore}\nconst backend=(()=>{const module={exports:{}};const exports=module.exports;${zlibBackend}\nreturn module.exports})();\n${zlibSource}`,
  'node:dns':dnsSource,
  'node:dns/promises':`import {promises} from 'node:dns';export const {lookup,getDefaultResultOrder,setDefaultResultOrder}=promises;export default promises;`,
  'node:child_process':`${ipcCodecSource}\n${ipcChannelSource}\n${childProcessSource}`,
  'node:cluster':clusterSource,
  'node:net':netSource,
  'node:dgram':dgramSource,
  'node:http':httpSource,
  'node:http2':http2Source,
  'node:tls':tlsSource,
  'node:https':httpsSource,
  'node:readline':readlineSource,
  'node:console':consoleSource,
  'node:readline/promises':`import {promises} from 'node:readline';export const {Interface,createInterface}=promises;export default promises;`,
  'node:string_decoder':`${nodeCore}\nexport const {StringDecoder}=core.stringDecoder;export default core.stringDecoder;`,
  'node:tty': `
    import process from 'node:process';
    export const isatty=fd=>Number.isInteger(fd)&&fd>=0&&fd<=2&&[process.stdin,process.stdout,process.stderr][fd]?.isTTY===true;
    export class ReadStream {constructor(){throw Object.assign(Error('This sandbox has no terminal device'),{code:'ERR_TTY_INIT_FAILED'})}}
    export class WriteStream extends ReadStream {}
    export default {isatty,ReadStream,WriteStream};
  `,
  'node:constants': fsConstantsSource,
  'node:util': `${nodeCore}
    const util=core.util;
    ${styleTextSource}
    ${utilParseArgsSource.replace('export function parseArgs','function parseArgs')}
    ${utilParseEnvSource.replace('export function parseEnv','function parseEnv')}
    util.TextEncoder=globalThis.TextEncoder;util.TextDecoder=globalThis.TextDecoder;
    util.parseArgs=parseArgs;
    util.parseEnv=parseEnv;
    export const {format,formatWithOptions,inspect,stripVTControlCharacters,debuglog,deprecate,promisify,callbackify,inherits,types,isDeepStrictEqual,_extend,isArray,isBoolean,isNull,isNullOrUndefined,isNumber,isString,isSymbol,isUndefined,isRegExp,isObject,isDate,isError,isFunction,isPrimitive,isBuffer}=util;
    export {parseArgs,parseEnv};
    export const TextEncoder=globalThis.TextEncoder,TextDecoder=globalThis.TextDecoder;
    export default util;
  `,
  'node:util/types': `
    import {types} from 'node:util';
    export const {isAnyArrayBuffer,isArgumentsObject,isArrayBuffer,isArrayBufferView,isAsyncFunction,isBigInt64Array,isBigIntObject,isBigUint64Array,isBooleanObject,isBoxedPrimitive,isDataView,isDate,isFloat32Array,isFloat64Array,isGeneratorFunction,isGeneratorObject,isInt16Array,isInt32Array,isInt8Array,isMap,isMapIterator,isNativeError,isNumberObject,isPromise,isRegExp,isSet,isSetIterator,isSharedArrayBuffer,isStringObject,isSymbolObject,isTypedArray,isUint16Array,isUint32Array,isUint8Array,isUint8ClampedArray,isWeakMap,isWeakSet}=types;
    export default types;
  `,
  'node:assert': `${nodeCore}
    const assert=core.assert;
    export const {AssertionError,ok,fail,equal,notEqual,deepEqual,notDeepEqual,deepStrictEqual,notDeepStrictEqual,strictEqual,notStrictEqual,throws,doesNotThrow,rejects,doesNotReject,ifError,match,doesNotMatch,strict}=assert;
    export default assert;
  `,
  'node:assert/strict': `import assert from 'node:assert';export default assert.strict;export const {AssertionError,ok,fail,equal,notEqual,deepEqual,notDeepEqual,deepStrictEqual,notDeepStrictEqual,strictEqual,notStrictEqual,throws,doesNotThrow,rejects,doesNotReject,ifError,match,doesNotMatch}=assert.strict;`,
  'node:path/posix': `import {posix} from 'node:path';export default posix;export const {basename,delimiter,dirname,extname,format,isAbsolute,join,normalize,parse,relative,resolve,sep,win32,toNamespacedPath,matchesGlob,_makeLong}=posix;export {posix};`,
  'node:path/win32': `import {win32} from 'node:path';export default win32;export const {basename,delimiter,dirname,extname,format,isAbsolute,join,normalize,parse,relative,resolve,sep,posix,toNamespacedPath,matchesGlob,_makeLong}=win32;export {win32};`,
  'node:os': `
    import process from 'node:process';
    const unsupported=()=>{throw Object.assign(new Error('Physical host OS access is unavailable in this sandbox'),{code:'ERR_UNSUPPORTED_OPERATION'})};
    export const EOL='\\n',devNull='/dev/null';
    export const arch=()=>process.arch,platform=()=>process.platform,type=()=> 'BrowserSandbox',release=()=> '0.0.0';
    export const homedir=()=>process.env.HOME??'/',tmpdir=()=>process.env.TMPDIR??'/tmp',hostname=()=> 'sandbox';
    export const endianness=()=>new Uint8Array(new Uint16Array([1]).buffer)[0]===1?'LE':'BE';
    const virtualCPU=Object.freeze({model:'Virtual CPU',speed:0,times:Object.freeze({user:0,nice:0,sys:0,idle:0,irq:0})});
    export const availableParallelism=()=>1,uptime=()=>process.uptime();
    // Keep the two scheduling APIs internally consistent without exposing host
    // topology, model names, speeds, or utilization counters.
    export const cpus=()=>[{model:virtualCPU.model,speed:virtualCPU.speed,times:{...virtualCPU.times}}];
    const virtualMac='00:00:00:00:00:00';
    export const networkInterfaces=()=>({lo:[
      {address:'127.0.0.1',netmask:'255.0.0.0',family:'IPv4',mac:virtualMac,internal:true,cidr:'127.0.0.1/8'},
      {address:'::1',netmask:'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',family:'IPv6',mac:virtualMac,internal:true,cidr:'::1/128',scopeid:0},
    ]});
    export const freemem=unsupported,totalmem=unsupported,loadavg=unsupported,userInfo=unsupported,getPriority=unsupported,setPriority=unsupported;
    export default {EOL,devNull,arch,platform,type,release,homedir,tmpdir,hostname,endianness,availableParallelism,uptime,cpus,freemem,totalmem,loadavg,networkInterfaces,userInfo,getPriority,setPriority};
  `,
  'node:perf_hooks': performanceSource,
  'node:vm': vmModulesSource.replace('export function createVMModules','function createVMModules')+'\n'+vmSource.replace("import {createVMModules} from './guest-vm-modules.js'",''),
  'node:querystring': `${nodeCore}\nexport const {unescapeBuffer,unescape,escape,stringify,encode,parse,decode}=core.querystring;export default core.querystring;`,
  'node:crypto': `${nodeCore}\n${cryptoSource}`,
  'node:worker_threads': `
    ${ipcCodecSource}
    ${routedPortsSource}
    ${workerThreadsSource}
    export const {MessageChannel,MessagePort,receiveMessageOnPort}=routedPorts;
    export default {isMainThread,threadId,workerData,parentPort,SHARE_ENV,Worker,MessageChannel,MessagePort,receiveMessageOnPort};
  `,
  'node:module': `
    const modules=globalThis.__webContainerHost.modules;
    const names=new Set(availableBuiltins);
    export const builtinModules=Object.freeze(availableBuiltins.slice());
    export function isBuiltin(name){return typeof name==='string'&&names.has(name.startsWith('node:')?name.slice(5):name)}
    export function createRequire(filename){if(!modules)throw new Error('Runtime module loading is unavailable in this execution mode');return modules.createRequire(filename)}
    export function registerHooks(options){if(!modules)throw Object.assign(Error('Runtime module hooks are unavailable'),{code:'ERR_UNSUPPORTED_OPERATION'});return modules.registerHooks(options)}
    export function register(){throw Object.assign(Error('Asynchronous module.register loaders require a loader scheduling barrier and are not implemented'),{code:'ERR_UNSUPPORTED_OPERATION'})}
    export function preloadModuleSources(...args){if(!modules)throw Object.assign(Error('Runtime module preparation is unavailable'),{code:'ERR_UNSUPPORTED_OPERATION'});return modules.preloadModuleSources(...args)}
    export class Module {constructor(){throw Object.assign(Error('Direct Module construction is not implemented'),{code:'ERR_UNSUPPORTED_OPERATION'})}}
    Object.assign(Module,{Module,createRequire,builtinModules,isBuiltin,registerHooks,register,preloadModuleSources});
    export default Module;
  `,
  'node:buffer': `${nodeCore}
    export const {Buffer,SlowBuffer,INSPECT_MAX_BYTES,kMaxLength}=core.buffer;
    ${base64Source}
    ${bufferExtrasSource.replace('export function createBufferExtras','function createBufferExtras')}
    const extras=createBufferExtras(Buffer,globalThis.Blob,globalThis.File,globalThis.TextDecoder,globalThis.TextEncoder,kMaxLength,globalThis.URL,true,globalThis.__webContainerHost.pid);
    export const {Blob,File,constants,isAscii,isUtf8,kStringMaxLength,transcode,resolveObjectURL}=extras;
    Object.assign(core.buffer,extras);
    export default core.buffer;
  `,
  'node:url': `
    import {resolve as resolvePath} from 'node:path';
    export const URL=globalThis.URL,URLSearchParams=globalThis.URLSearchParams;
    const error=(code,message)=>Object.assign(new TypeError(message),{code});
    function posix(options){if(options?.windows===true)throw error('ERR_UNSUPPORTED_OPERATION','Windows paths are unavailable in the POSIX workspace')}
    export function pathToFileURL(path,options){
      posix(options);if(typeof path!=='string')throw error('ERR_INVALID_ARG_TYPE','Expected a path string');
      let absolute=resolvePath(path);if(path.endsWith('/')&&!absolute.endsWith('/'))absolute+='/';
      const url=new URL('file:///');
      url.pathname=absolute.replaceAll('%','%25').replaceAll('\\\\','%5C').replaceAll('#','%23').replaceAll('?','%3F').replaceAll('\\n','%0A').replaceAll('\\r','%0D').replaceAll('\\t','%09');
      return url;
    }
    export function fileURLToPath(value,options){
      posix(options);const url=typeof value==='string'?new URL(value):value;
      if(!(url instanceof URL))throw error('ERR_INVALID_ARG_TYPE','Expected file URL');
      if(url.protocol!=='file:')throw error('ERR_INVALID_URL_SCHEME','Expected file URL');
      if(url.hostname&&url.hostname!=='localhost')throw error('ERR_INVALID_FILE_URL_HOST','File URL host must be empty or localhost');
      if(/%2f/i.test(url.pathname))throw error('ERR_INVALID_FILE_URL_PATH','Encoded path separator');
      return decodeURIComponent(url.pathname);
    }
    export function format(value,options={}){
      if(value===null||value===undefined)throw error('ERR_INVALID_ARG_TYPE','Expected a URL, URL string, or URL object');
      if(value instanceof URL){
        const url=new URL(value.href);
        if(options.auth===false){url.username='';url.password=''}
        if(options.search===false)url.search='';
        if(options.fragment===false)url.hash='';
        return url.href;
      }
      if(typeof value==='string')return value;
      const protocol=value.protocol??'',slashes=value.slashes||value.host!==undefined;
      const auth=value.auth?encodeURIComponent(value.auth).replace('%3A',':')+'@':'';
      const host=value.host??((value.hostname??'')+(value.port?':'+value.port:''));
      const pathname=value.pathname??'',search=value.search??(value.query?'?'+String(value.query):''),hash=value.hash??'';
      return protocol+(slashes?'//':'')+auth+host+pathname+search+hash;
    }
    export function urlToHttpOptions(url){return {...url,protocol:url.protocol,hostname:url.hostname.startsWith('[')?url.hostname.slice(1,-1):url.hostname,hash:url.hash,search:url.search,pathname:url.pathname,path:url.pathname+url.search,href:url.href,...(url.port?{port:Number(url.port)}:{}),...(url.username||url.password?{auth:decodeURIComponent(url.username)+':'+decodeURIComponent(url.password)}:{})}}
    export default {URL,URLSearchParams,pathToFileURL,fileURLToPath,format,urlToHttpOptions};
  `,
  'node:fs': `
    import path from 'node:path';
    import promises from 'node:fs/promises';
    import {Readable,Writable} from 'node:stream';
    import {EventEmitter} from 'node:events';
    import {Buffer} from 'node:buffer';
    import constants from 'node:constants';
    ${fsPathsSource}
    export {constants};
    const call = (method, args) => {
      const fs = globalThis.__webContainerHost.fsSync;
      if (!fs) throw new Error('Synchronous filesystem is unavailable in this backend');
      if(typeof fs[method]!=='function')throw Object.assign(new Error('Filesystem operation unavailable: '+method),{code:'ERR_UNSUPPORTED_OPERATION'});
      return fs[method](...pathArguments(method,args));
    };
    const settings=option=>typeof option==='string'?{encoding:option}:option??{};
    export function readFileSync(path,option){const o=settings(option),value=call('readFile',[path]);const bytes=Buffer.from(value);return o.encoding?bytes.toString(o.encoding):bytes}
    export function writeFileSync(path,data,option){const o=settings(option);if(typeof data==='string')data=Buffer.from(data,o.encoding??'utf8');else if(ArrayBuffer.isView(data))data=Buffer.from(data.buffer,data.byteOffset,data.byteLength);else throw Object.assign(new TypeError('Expected a string or byte view'),{code:'ERR_INVALID_ARG_TYPE'});call('writeFile',[path,data,o])}
    export const appendFileSync=(path,data,option)=>writeFileSync(path,data,{...settings(option),flag:settings(option).flag??'a'});
    ${fsTypesSource}
    export const {Dirent,Stats}=fsTypes;
    ${fsDescriptorsSource}
    export const {openSync,closeSync,readSync,writeSync,readvSync,writevSync,fstatSync,ftruncateSync,read,write,readv,writev}=descriptorAPI;
    ${fsStreamsSource}
    export function readdirSync(path,option){const o=settings(option),entries=call('readdir',[path,o]);return o.withFileTypes?entries.map(value=>new Dirent(value,o.encoding)):o.encoding==='buffer'?entries.map(value=>Buffer.from(value)):entries}
    export const mkdirSync=(...args)=>call('mkdir',args)??undefined,chmodSync=(...args)=>{call('chmod',args)};
    ${fsMkdtempSource}
    const tempAPI=createMkdtempAPI({mkdir:mkdirSync,filePath,Buffer,randomBytes:size=>{const random=globalThis.__webContainerHost.randomBytes;if(!random)throw new Error('Secure randomness is unavailable in this backend');return JSON.parse(random(size))}});
    export const mkdtempSync=(prefix,options)=>tempAPI.create(tempAPI.prepare(prefix,options));
    export function mkdtemp(prefix,options,callback){if(typeof options==='function'){callback=options;options=undefined}if(typeof callback!=='function')throw Object.assign(new TypeError('Expected callback'),{code:'ERR_INVALID_ARG_TYPE'});const prepared=tempAPI.prepare(prefix,options);descriptorAPI.dispatch(()=>{let value;try{value=tempAPI.create(prepared)}catch(error){callback(error);return}callback(null,value)})}
    export const rmdirSync=(...args)=>{call('rmdir',args)},rmSync=(...args)=>{call('rm',args)},unlinkSync=(...args)=>{call('unlink',args)},renameSync=(...args)=>{call('rename',args)},copyFileSync=(...args)=>{call('copyFile',args)},truncateSync=(...args)=>{call('truncate',args)};
    const syncStats=(method,args)=>{try{return fsTypes.stats(call(method,args),args[1])}catch(error){const code=error?.code??String(error?.message).split(':',1)[0];if(args[1]?.throwIfNoEntry===false&&(code==='ENOENT'||method==='stat'&&code==='ENOTDIR'))return undefined;throw error}};
    export const statSync=(...args)=>syncStats('stat',args);
    export const lstatSync=(...args)=>syncStats('lstat',args);
    export const symlinkSync=(target,path,type)=>{call('symlink',[path,target,type])};
    export const readlinkSync=(path,option)=>{const bytes=Buffer.from(call('readlink',[path]));const o=settings(option);return o.encoding==='buffer'?bytes:bytes.toString(o.encoding??'utf8')};
    export const accessSync=(...args)=>call('access',args);
    export const existsSync = path => {
      try{path=filePath(path)}catch{return false}
      try{return call('exists',[path])}catch(error){if(/^(EACCES|EINVAL|ENOENT|ENOTDIR):/.test(error.message))return false;throw error}
    };
    export const realpathSync = (...args) => call('realpath', args);
    ${fsCopySource.replace('export function createCopyAPI','function createCopyAPI')}
    const copyAPI=createCopyAPI({lstatSync,statSync,realpathSync,mkdirSync,readdirSync,readlinkSync,symlinkSync,unlinkSync,copyFileSync},path,filePath);
    export const cpSync=(...args)=>copyAPI.cpSync(...args);
    export function cp(source,destination,options,callback){if(typeof options==='function'){callback=options;options=undefined}if(typeof callback!=='function')throw Object.assign(new TypeError('Expected callback'),{code:'ERR_INVALID_ARG_TYPE'});const host=globalThis.__webContainerHost,invoke=error=>globalThis[Symbol.for('web-container:task-queue')].task(callback,undefined,[error]);if(!host.filesystemTask){copyAPI.cp(source,destination,options).then(()=>invoke(null),invoke);return}descriptorAPI.task(()=>copyAPI.cp(source,destination,options)).then(()=>invoke(null),invoke).catch(error=>host.reportError(error))}
    realpathSync.native=realpathSync;
    const callback=(operation,args)=>{
      const fn=args.pop();if(typeof fn!=='function')throw Object.assign(new TypeError('Expected callback'),{code:'ERR_INVALID_ARG_TYPE'});
      descriptorAPI.dispatch(()=>{let value;try{value=operation(...args)}catch(error){fn(error);return}fn(null,value)});
    };
    export const readFile=(...args)=>callback(readFileSync,args),writeFile=(...args)=>callback(writeFileSync,args),readdir=(...args)=>callback(readdirSync,args);
    export const open=(...args)=>callback(openSync,args),close=(...args)=>callback(closeSync,args),fstat=(...args)=>callback(fstatSync,args),ftruncate=(...args)=>callback(ftruncateSync,args);
    export const stat=(...args)=>callback(statSync,args),lstat=(...args)=>callback(lstatSync,args),access=(...args)=>callback(accessSync,args),realpath=(...args)=>callback(realpathSync,args),chmod=(...args)=>callback(chmodSync,args);
    export const symlink=(...args)=>callback(symlinkSync,args),readlink=(...args)=>callback(readlinkSync,args);
    export const appendFile=(...args)=>callback(appendFileSync,args),mkdir=(...args)=>callback(mkdirSync,args),rmdir=(...args)=>callback(rmdirSync,args),rm=(...args)=>callback(rmSync,args),unlink=(...args)=>callback(unlinkSync,args),rename=(...args)=>callback(renameSync,args),copyFile=(...args)=>callback(copyFileSync,args),truncate=(...args)=>callback(truncateSync,args);
    realpath.native=realpath;
    export class FSWatcher extends EventEmitter {
      constructor(path,options,listener){
        super();
        const host=globalThis.__webContainerHost;
        if(!host.watchOpen)throw new Error('Filesystem watch is unavailable in this backend');
        if(options.signal&&typeof options.signal.addEventListener!=='function')throw new TypeError('Expected AbortSignal');
        this.closed=false;
        this.dispatch=host.AsyncLocalStorage.bind((...args)=>this.emit(...args));
        if(listener)this.on('change',listener);
        this.key=host.watchOpen(filePath(path),!!options.recursive,options.persistent!==false);
        const next=()=>host.watchNext(this.key).then(value=>{
          if(this.closed||value===null)return;
          const event=JSON.parse(value);
          globalThis[Symbol.for('web-container:task-queue')].task(this.dispatch,this,['change',event.eventType,options.encoding==='buffer'?Buffer.from(event.filename):event.filename]);
          if(!this.closed)next();
        }).catch(error=>{if(this.closed)return;this.close();globalThis[Symbol.for('web-container:task-queue')].task(this.dispatch,this,['error',error])});
        next();
        if(options.signal){
          const abort=()=>this.close();
          this.cleanup=()=>options.signal.removeEventListener('abort',abort);
          if(options.signal.aborted)queueMicrotask(abort);
          else options.signal.addEventListener('abort',abort,{once:true});
        }
      }
      close(){if(this.closed)return;this.closed=true;globalThis.__webContainerHost.watchClose(this.key);this.cleanup?.();queueMicrotask(()=>this.dispatch('close'))}
      ref(){globalThis.__webContainerHost.watchRef(this.key,true);return this}
      unref(){globalThis.__webContainerHost.watchRef(this.key,false);return this}
    }
    export function watch(path,options={},listener){
      if(typeof options==='function'){listener=options;options={}}
      if(typeof options==='string')options={encoding:options};
      options??={};
      if(options.encoding&&!['utf8','utf-8','buffer'].includes(options.encoding))throw new Error('Unsupported watch encoding');
      return new FSWatcher(path,options,listener);
    }
    ${fsWatchSource}
    const statWatchAPI=createStatWatchAPI({EventEmitter,statSync,resolvePath:value=>path.resolve(filePath(value)),makeStats:fsTypes.stats});
    export const {watchFile,unwatchFile,StatWatcher}=statWatchAPI;
    export { promises };
    export default {mkdtemp,mkdtempSync,cp,cpSync,ReadStream,WriteStream,createReadStream,createWriteStream,open,close,read,write,readv,writev,fstat,ftruncate,openSync,closeSync,readSync,writeSync,readvSync,writevSync,fstatSync,ftruncateSync,readFile,writeFile,readdir,stat,lstat,access,realpath,chmod,constants,readFileSync,writeFileSync,readdirSync,statSync,lstatSync,accessSync,existsSync,realpathSync,chmodSync,watch,watchFile,unwatchFile,StatWatcher,FSWatcher,promises,Dirent,Stats,symlink,symlinkSync,readlink,readlinkSync,appendFile,appendFileSync,mkdir,mkdirSync,rmdir,rmdirSync,rm,rmSync,unlink,unlinkSync,rename,renameSync,copyFile,copyFileSync,truncate,truncateSync};
  `,
  'node:events': `
    import {AsyncResource} from 'node:async_hooks';
    ${asyncResourceSource}
    const implementation=globalThis.__webContainerHost.EventEmitter??=(()=>{const module={exports:{}};const exports=module.exports;${eventsSource}\nreturn module.exports})();
    ${eventsExtrasSource.replace('export function createEventsExtras','function createEventsExtras')}
    const extras=createEventsExtras(implementation);
    export const {EventEmitter,addAbortListener,captureRejectionSymbol,errorMonitor,getEventListeners,getMaxListeners,setMaxListeners,on,init,usingDomains}=extras,once=implementation.once;
    export const captureRejections=EventEmitter.captureRejections,defaultMaxListeners=EventEmitter.defaultMaxListeners;
    export const listenerCount=implementation.listenerCount;
    export const EventEmitterAsyncResource=createAsyncEmitter(EventEmitter,AsyncResource);
    EventEmitter.EventEmitterAsyncResource=EventEmitterAsyncResource;
    export default EventEmitter;
  `,
  'node:timers': `
    export const {setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate}=globalThis;
    export default {setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate};
  `,
  'node:timers/promises':timersPromisesSource,
  'node:process': `
    import {EventEmitter} from 'node:events';
    const host = globalThis.__webContainerHost
    export const env = host.env
    export const argv = host.argv ?? ['/usr/bin/browser-node', '/src/server.ts']
    export const execArgv = host.execArgv ?? []
    export const pid=host.pid??1,ppid=host.ppid??0,execPath='/usr/bin/browser-node';
    export const cwd = () => host.proc?host.proc.call('cwd'):'/'
    export const chdir = path => {if(!host.proc)throw Object.assign(Error('Process directories are unavailable in this backend'),{code:'ERR_UNSUPPORTED_OPERATION'});if(typeof path!=='string')throw Object.assign(new TypeError('Expected a directory path'),{code:'ERR_INVALID_ARG_TYPE'});host.proc.call('chdir',path)}
    export const platform = 'browser'
    export const arch = 'wasm32'
    export const browser = true
    export const version = ${JSON.stringify('v'+nodeCompatibilityVersion)}
    export const versions = { node: ${JSON.stringify(nodeCompatibilityVersion)}, tanstackSandbox: ${JSON.stringify(sandboxVersion)} }
    export const release = { name: 'browser-node' }
    export const nextTick = (callback, ...args) => globalThis[Symbol.for('web-container:task-queue')].nextTick(callback,...args)
    export function exit(code){
      if(!host.exit)throw Object.assign(Error('Immediate exit requires a termination-capable engine'),{code:'ERR_UNSUPPORTED_OPERATION'});
      code=code===undefined?(process.exitCode??0):code;
      if(typeof code==='string'&&code.trim()!=='')code=Number(code);
      if(typeof code!=='number')throw Object.assign(new TypeError('Exit code must be a number or integer string'),{code:'ERR_INVALID_ARG_TYPE'});
      if(!Number.isInteger(code))throw Object.assign(new RangeError('Exit code must be an integer'),{code:'ERR_OUT_OF_RANGE'});
      process.exitCode=code;
      if(!process._exiting){process._exiting=true;process.emit('exit',code)}
      host.exit(process.exitCode);
    }
    const now=()=>{if(!host.now)throw Error('Monotonic clock is unavailable in this backend');return host.now()};
    export const uptime=()=>now()/1000;
    export function hrtime(previous){
      const nanos=BigInt(Math.floor(now()*1e6));
      let value=nanos;
      if(previous!==undefined){if(!Array.isArray(previous)||previous.length!==2||previous.some(n=>!Number.isInteger(n)))throw new TypeError('Expected a time tuple');value-=BigInt(previous[0])*1000000000n+BigInt(previous[1])}
      let seconds=value/1000000000n,remainder=value%1000000000n;if(remainder<0){seconds--;remainder+=1000000000n}
      return [Number(seconds),Number(remainder)];
    }
    hrtime.bigint=()=>BigInt(Math.floor(now()*1e6));
    export function memoryUsage(){
      if(!host.proc)throw Object.assign(Error('Guest memory measurements are unavailable in this backend'),{code:'ERR_UNSUPPORTED_OPERATION'});
      const measured=host.proc.call('memoryUsage');
      for(const name of ['rss','external','arrayBuffers'])Object.defineProperty(measured,name,{enumerable:true,get(){throw Object.assign(Error(name+' memory accounting is unavailable in this sandbox'),{code:'ERR_UNSUPPORTED_OPERATION'})}});
      return measured;
    }
    memoryUsage.rss=()=>{throw Object.assign(Error('Host RSS is unavailable in this sandbox'),{code:'ERR_UNSUPPORTED_OPERATION'})};
    export const report={
      directory:'',filename:'',compact:false,excludeNetwork:true,signal:'',reportOnFatalError:false,reportOnSignal:false,reportOnUncaughtException:false,excludeEnv:true,
      getReport(){return {header:{
        reportVersion:5,event:'JavaScript API',trigger:'GetReport',filename:null,
        processId:pid,threadId:0,cwd:cwd(),commandLine:argv.slice(),nodejsVersion:version,
        wordSize:32,arch,platform,componentVersions:{...versions},release:{...release},
        osName:'BrowserSandbox',osRelease:'0.0.0',osVersion:'Virtual browser sandbox',osMachine:arch,
        cpus:[{model:'Virtual CPU',speed:0,times:{user:0,nice:0,sys:0,idle:0,irq:0}}],networkInterfaces:[]
      }}}
    };
    const getGuestProcess=(()=>{const module={exports:{}};${processStateSource}\nreturn module.exports})();
    const process = Object.assign(getGuestProcess(EventEmitter),{ argv, execArgv, arch, browser, cwd, chdir, env, nextTick, platform, release, report, version, versions,uptime,hrtime,pid,ppid,execPath });
    globalThis.process=process;
    process.exit=exit;
    process.memoryUsage=memoryUsage;
    const core=${initializeNodeCore};
    ${ipcCodecSource}
    ${ipcChannelSource}
    if(host.ipcMode){
      attachIPC(process,pid,host.ipcMode,host,core.buffer.Buffer,nextTick,encodeIPC,decodeIPC);
      const updateIPCRef=()=>host.proc.call('ipcRef',process.listenerCount('message')>0||process.listenerCount('disconnect')>0);
      process.on('newListener',name=>{if(name==='message'||name==='disconnect')nextTick(updateIPCRef)});
      process.on('removeListener',updateIPCRef);
    }
    function output(fd){
      const stream=new core.stream.Writable({write(chunk,_encoding,done){
        try{
          if(!host.writeOutput)throw Object.assign(Error('Process output is unavailable in this backend'),{code:'ERR_UNSUPPORTED_OPERATION'});
          const result=(host.writeOutputAsync??host.writeOutput)(fd,chunk);
          if(result&&typeof result.then==='function')result.then(()=>done(),done);else done();
        }catch(error){done(error)}
      }});
      Object.defineProperty(stream,'fd',{value:fd,enumerable:true});
      stream._isStdio=true;
      return stream;
    }
    export const stdout=process.stdout=output(1),stderr=process.stderr=output(2);
    let reading=false;
    export const stdin=process.stdin=new core.stream.Readable({
      read(){
        if(reading)return;
        if(!host.proc){this.destroy(Object.assign(Error('Process input is unavailable in this backend'),{code:'ERR_UNSUPPORTED_OPERATION'}));return}
        reading=true;
        host.proc.readInput().then(bytes=>{reading=false;if(!this.destroyed)this.push(bytes===null?null:core.buffer.Buffer.from(bytes))},error=>{reading=false;this.destroy(error)}).catch(error=>host.reportError(error));
      },
      destroy(error,done){host.proc?.call('inputRef',false);done(error)}
    });
    Object.defineProperty(stdin,'fd',{value:0,enumerable:true});stdin._isStdio=true;
    stdin.on('pause',()=>host.proc?.call('inputRef',false));
    stdin.on('resume',()=>{if(!stdin.readableEnded)host.proc?.call('inputRef',true)});
    ${ttySource}
    attachTerminal(process,host);
    export default process
  `,
  'node:path': `${nodeCore}
    export const {basename,delimiter,dirname,extname,format,isAbsolute,join,normalize,parse,relative,resolve,sep,posix,win32,toNamespacedPath,matchesGlob,_makeLong}=core.path;
    export default core.path;
  `,
  'node:fs/promises': `
    import {cp as copyWithCallback,watch as watchWithCallback,mkdtemp as tempWithCallback} from 'node:fs';
    export const mkdtemp=(prefix,options)=>new Promise((resolve,reject)=>tempWithCallback(prefix,options,(error,value)=>error?reject(error):resolve(value)));
    ${fsWatchSource}
    export const watch=createPromiseWatch(watchWithCallback);
    export const cp=(source,destination,options)=>new Promise((resolve,reject)=>copyWithCallback(source,destination,options,error=>error?reject(error):resolve()));
    import {Buffer} from 'node:buffer';
    import constants from 'node:constants';
    ${fsPathsSource}
    export {constants};
    ${fsTypesSource}
    ${fsDescriptorsSource}
    class FileHandle {
      #fd;
      #active=0;#drained;#closing;
      constructor(fd){this.#fd=fd}
      get fd(){return this.#fd}
      async #run(operation){
        if(this.#fd===-1)throw Object.assign(new Error('FileHandle is closed'),{code:'EBADF'});
        const fd=this.#fd;this.#active++;
        try{return await operation(fd)}finally{if(--this.#active===0){this.#drained?.();this.#drained=undefined}}
      }
      close(){
        if(this.#closing)return this.#closing;
        const fd=this.#fd;
        return this.#closing=(async()=>{while(this.#active)await new Promise(resolve=>this.#drained=resolve);this.#fd=-1;await descriptorAPI.task(descriptorAPI.closeSync,fd)})();
      }
      stat(options){return this.#run(fd=>descriptorAPI.task(descriptorAPI.fstatSync,fd,options))}
      readFile(options){return this.#run(async fd=>{
        const settings=typeof options==='string'?{encoding:options}:options??{};
        if(settings.signal!==undefined)throw Object.assign(new Error('FileHandle readFile abort signals are not implemented'),{code:'ERR_UNSUPPORTED_OPERATION'});
        const chunks=[];let total=0;
        for(;;){
          const buffer=Buffer.alloc(65536),count=await descriptorAPI.task(descriptorAPI.readSync,fd,buffer,0,buffer.length,null);
          if(!count)break;
          chunks.push(buffer.subarray(0,count));total+=count;
        }
        const bytes=Buffer.concat(chunks,total);return settings.encoding?bytes.toString(settings.encoding):bytes;
      })}
      truncate(length){return this.#run(fd=>descriptorAPI.task(descriptorAPI.ftruncateSync,fd,length))}
      writeFile(data,options){return this.#run(async fd=>{
        const settings=typeof options==='string'?{encoding:options}:options??{};
        if(settings.signal!==undefined)throw Object.assign(new Error('FileHandle writeFile abort signals are not implemented'),{code:'ERR_UNSUPPORTED_OPERATION'});
        if(typeof data==='string')data=Buffer.from(data,settings.encoding??'utf8');
        else if(ArrayBuffer.isView(data))data=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
        else if(data!=null&&(typeof data[Symbol.iterator]==='function'||typeof data[Symbol.asyncIterator]==='function'))throw Object.assign(new Error('FileHandle writeFile iterables are not implemented'),{code:'ERR_UNSUPPORTED_OPERATION'});
        else throw Object.assign(new TypeError('Expected a string or byte view'),{code:'ERR_INVALID_ARG_TYPE'});
        for(let offset=0;offset<data.byteLength;){
          const count=await descriptorAPI.task(descriptorAPI.writeSync,fd,data,offset,Math.min(65536,data.byteLength-offset),null);
          if(!count)throw Object.assign(new Error('FileHandle writeFile made no progress'),{code:'EIO'});
          offset+=count;
        }
      })}
      read(buffer,...args){return this.#run(async fd=>{
        if(!ArrayBuffer.isView(buffer)){const options=buffer??{};buffer=options.buffer??Buffer.alloc(16384);args=[options]}
        return {bytesRead:await descriptorAPI.task(descriptorAPI.readSync,fd,buffer,...args),buffer};
      })}
      write(buffer,...args){return this.#run(async fd=>({bytesWritten:await descriptorAPI.task(descriptorAPI.writeSync,fd,buffer,...args),buffer}))}
      readv(buffers,position){return this.#run(async fd=>{const views=descriptorAPI.vectorViews(buffers);return {bytesRead:await descriptorAPI.task(descriptorAPI.readvSync,fd,views,position),buffers}})}
      writev(buffers,position){return this.#run(async fd=>{const views=descriptorAPI.vectorViews(buffers);return {bytesWritten:await descriptorAPI.task(descriptorAPI.writevSync,fd,views,position),buffers}})}
    }
    export const open=async(path,flags,mode)=>new FileHandle(await descriptorAPI.task(descriptorAPI.openSync,path,flags,mode));
    const fs=globalThis.__webContainerHost.fs;
    const settings=option=>typeof option==='string'?{encoding:option}:option??{};
    const call=(method,args)=>{if(typeof fs?.[method]!=='function')throw Object.assign(new Error('Filesystem operation unavailable: '+method),{code:'ERR_UNSUPPORTED_OPERATION'});return fs[method](...pathArguments(method,args))};
    export const readFile=async(path,option)=>{const o=settings(option),bytes=Buffer.from(await call('readFile',[path]));return o.encoding?bytes.toString(o.encoding):bytes};
    export const writeFile=async(path,data,option)=>{const o=settings(option);if(typeof data==='string')data=Buffer.from(data,o.encoding??'utf8');else if(ArrayBuffer.isView(data))data=Buffer.from(data.buffer,data.byteOffset,data.byteLength);else throw Object.assign(new TypeError('Expected a string or byte view'),{code:'ERR_INVALID_ARG_TYPE'});await call('writeFile',[path,data,o])};
    export const appendFile=(path,data,option)=>writeFile(path,data,{...settings(option),flag:settings(option).flag??'a'});
    export const readdir=async(path,option)=>{const o=settings(option),entries=await call('readdir',[path,o]);return o.withFileTypes?entries.map(value=>new fsTypes.Dirent(value,o.encoding)):o.encoding==='buffer'?entries.map(value=>Buffer.from(value)):entries};
    export const stat=async(...args)=>fsTypes.stats(await call('stat',args),args[1]),lstat=async(...args)=>fsTypes.stats(await call('lstat',args),args[1]),access=async(...args)=>{await call('access',args)},realpath=async(...args)=>call('realpath',args),chmod=async(...args)=>{await call('chmod',args)};
    export const symlink=async(target,path,type)=>{await call('symlink',[path,target,type])};
    export const readlink=async(path,option)=>{const bytes=Buffer.from(await call('readlink',[path])),o=settings(option);return o.encoding==='buffer'?bytes:bytes.toString(o.encoding??'utf8')};
    export const mkdir=async(...args)=>(await call('mkdir',args))??undefined;
    export const rmdir=async(...args)=>{await call('rmdir',args)},rm=async(...args)=>{await call('rm',args)},unlink=async(...args)=>{await call('unlink',args)},rename=async(...args)=>{await call('rename',args)},copyFile=async(...args)=>{await call('copyFile',args)},truncate=async(...args)=>{await call('truncate',args)};
    export default {mkdtemp,cp,watch,open,constants,readFile,readdir,stat,lstat,access,realpath,chmod,symlink,readlink,writeFile,appendFile,mkdir,rmdir,rm,unlink,rename,copyFile,truncate};
  `,
  'node:async_hooks': `
    const registryKey = Symbol.for('web-container:async-local-storage-registry')
    const registry = globalThis[registryKey] ??= new Set()

    function restoreAfter(result, restore) {
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(restore)
      }
      restore()
      return result
    }

    function capture() {
      return [...registry].map((storage) => [storage, storage._store])
    }

    function runSnapshot(snapshot, callback, thisArg, args) {
      const previous = capture()
      for (const [storage, store] of snapshot) storage._store = store
      let result
      try {
        result = callback.apply(thisArg, args)
      } catch (error) {
        for (const [storage, store] of previous) storage._store = store
        throw error
      }
      return restoreAfter(result, () => {
        for (const [storage, store] of previous) storage._store = store
      })
    }

    class LegacyAsyncLocalStorage {
      constructor() {
        this._store = undefined
        registry.add(this)
      }

      static bind(callback) {
        const snapshot = capture()
        return function (...args) {
          return runSnapshot(snapshot, callback, this, args)
        }
      }

      static snapshot() {
        const snapshot = capture()
        return (callback, ...args) => runSnapshot(snapshot, callback, undefined, args)
      }

      disable() {
        this._store = undefined
      }

      enterWith(store) {
        this._store = store
      }

      exit(callback, ...args) {
        return this.run(undefined, callback, ...args)
      }

      getStore() {
        return this._store
      }

      run(store, callback, ...args) {
        const previous = this._store
        const retained = globalThis.__webContainerHost.asyncContext?.retain(this, previous) ?? false
        this._store = store
        let result
        try {
          result = callback(...args)
        } catch (error) {
          if (!retained) this._store = previous
          throw error
        }
        return restoreAfter(result, () => {
          if (!retained) this._store = previous
        })
      }
    }

    export const AsyncLocalStorage = globalThis.__webContainerHost.AsyncLocalStorage ?? LegacyAsyncLocalStorage
    ${asyncResourceSource}
    export const {AsyncResource,executionAsyncId,triggerAsyncId,executionAsyncResource}=createAsyncResources(AsyncLocalStorage)
    export default { AsyncLocalStorage,AsyncResource,executionAsyncId,triggerAsyncId,executionAsyncResource }
  `,
  'node:stream/web': `
    export const ReadableStream = globalThis.ReadableStream
    export const ReadableStreamDefaultController = globalThis.ReadableStreamDefaultController
    export const ReadableStreamDefaultReader = globalThis.ReadableStreamDefaultReader
    export const TransformStream = globalThis.TransformStream
    export const TransformStreamDefaultController = globalThis.TransformStreamDefaultController
    export const WritableStream = globalThis.WritableStream
    export const WritableStreamDefaultController = globalThis.WritableStreamDefaultController
    export const WritableStreamDefaultWriter = globalThis.WritableStreamDefaultWriter
    export default { ReadableStream, TransformStream, WritableStream }
  `,
  'node:stream': `${nodeCore}
    export const {Stream,Readable,Writable,Duplex,Transform,PassThrough,pipeline,finished,compose,addAbortSignal,destroy,isDestroyed,isDisturbed,isErrored,isReadable,isWritable,getDefaultHighWaterMark,setDefaultHighWaterMark}=core.stream;
    export const promises=core.stream.promises;
    export default core.stream;
  `,
  'node:stream/promises': `${nodeCore}
    export const {pipeline,finished}=core.stream.promises;
    export default core.stream.promises;
  `,
}

// Derive the public catalog from the same definitions used by both compilers
// and the runtime resolver. It describes available modules, not full Node API
// compatibility, and does not advertise unavailable host-native modules.
export const builtinModules:Record<string,string>={
  ...builtinDefinitions,
  'node:module':`const availableBuiltins=${JSON.stringify(Object.keys(builtinDefinitions).map(name=>name.slice(5)).sort())};\n${builtinDefinitions['node:module']}`,
}

export function normalizeBuiltinSpecifier(
  specifier: string,
): string | undefined {
  if (specifier in builtinModules) return specifier
  const nodeSpecifier = `node:${specifier}`
  return nodeSpecifier in builtinModules ? nodeSpecifier : undefined
}
