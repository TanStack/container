import {dirname,join,normalize} from '../vite-browser/node-path'
import {existsSync,statSync,readFileSync} from '../vite-browser/node-fs'
import {createRequire,isBuiltin} from '../vite-browser/node-module'
import {isNativeProcessExit} from './process-exit'
import {parseSync,transformSync} from '@babel/core'
import {isContainerModulePath,resolveVolumePrivateImport} from './volume-resolver'

type ModuleRecord={id:string,filename:string,exports:unknown,loaded:boolean}
interface ExportConditions{[condition:string]:ExportTarget}
type ExportTarget=string|null|ExportTarget[]|ExportConditions
const extensions=['','.js','.cjs','.json']
function exportTarget(target:ExportTarget,subpath:string,conditions:readonly string[]=[]):string|null|undefined{
  if(typeof target==='string')return target.replaceAll('*',subpath)
  if(target===null)return null
  if(Array.isArray(target)){
    for(const candidate of target){const resolved=exportTarget(candidate,subpath,conditions);if(resolved!==undefined)return resolved}
    return
  }
  for(const [condition,candidate] of Object.entries(target)){
    if(condition==='require'||condition==='node'||condition==='default'||conditions.includes(condition)){
      const resolved=exportTarget(candidate,subpath,conditions)
      if(resolved!==undefined)return resolved
    }
  }
}

export class BrowserCommonJS{
  #cache=new Map<string,ModuleRecord>()
  #refreshing=false
  constructor(
    private readonly loadExternal?:(resolved:string)=>unknown|undefined,
    private readonly dynamicImport?:(specifier:string,from:string)=>Promise<unknown>,
    private readonly preferBrowser=true,
    private readonly conditions:()=>readonly string[]=()=>[],
  ){}

  /** Reload the whole dependency graph, restoring cached exports if publication fails. */
  async refresh<T>(publish:()=>Promise<T>):Promise<T>{
    if(this.#refreshing)throw Error('CommonJS cache refresh is already running')
    const previous=this.#cache
    this.#refreshing=true
    this.#cache=new Map()
    try{return await publish()}
    catch(error){this.#cache=previous;throw error}
    finally{this.#refreshing=false}
  }

  createFunctionConstructor(from:string){return this.#functionConstructor(from)}

  #functionConstructor(from:string):FunctionConstructor{
    const dynamicImport=this.dynamicImport
    return new Proxy(Function,{
      apply(target,_thisArg,args){return compile(args)},
      construct(_target,args){return compile(args)},
    }) as FunctionConstructor

    function compile(args:unknown[]):Function{
      const source=String(args.at(-1)??'')
      if(!/\bimport\s*\(/.test(source))return Function(...args.map(String))
      let hasDynamicImport=false
      const transformed=transformSync(source,{
        babelrc:false,configFile:false,sourceType:'script',parserOpts:{allowReturnOutsideFunction:true},
        plugins:[()=>({visitor:{CallExpression(path:any){
          if(path.node.callee.type==='Import'){
            hasDynamicImport=true
            path.node.callee={type:'Identifier',name:'__volumeImport'}
          }
        }}})],
      })?.code
      if(!hasDynamicImport)return Function(...args.map(String))
      if(!dynamicImport)throw Error(`Dynamic import is unavailable from ${from}`)
      if(!transformed)throw Error(`Cannot transform dynamic import from ${from}`)
      const compiled=Function('__volumeImport',...args.slice(0,-1).map(String),transformed)
      const importer=(specifier:string)=>dynamicImport(specifier,from)
      return new Proxy(compiled,{
        apply(target,thisArg,values){return Reflect.apply(target,thisArg,[importer,...values])},
        construct(target,values,newTarget){return Reflect.construct(target,[importer,...values],newTarget)},
      })
    }
  }

  resolve(specifier:string,from:string):string{
    if(isBuiltin(specifier))return specifier
    const target=specifier.startsWith('/')?specifier:specifier.startsWith('.')?join(dirname(from),specifier):this.#resolvePackage(specifier,from)
    return this.#resolveFile(target)
  }

  isCommonJS(filename:string):boolean{
    if(filename.endsWith('.cjs'))return true
    if(!filename.endsWith('.js')){
      const name=filename.slice(filename.lastIndexOf('/')+1)
      if(name.includes('.')||!existsSync(filename)||!statSync(filename).isFile())return false
      const firstLine=(readFileSync(filename,'utf8') as string).split('\n',1)[0]!
      if(!/^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+node(?:\s|$)|\/\S*\/node(?:\s|$))/.test(firstLine))return false
    }
    let directory=dirname(filename)
    while(isContainerModulePath(directory+'/')){
      const manifest=join(directory,'package.json')
      if(existsSync(manifest)){
        const packageJson=JSON.parse(readFileSync(manifest,'utf8') as string) as {type?:string;module?:string}
        if(typeof packageJson.module==='string'){
          const moduleEntry=normalize(join(directory,packageJson.module))
          const moduleDirectory=dirname(moduleEntry)
          if(moduleEntry===filename)return false
          if(moduleDirectory!==directory&&filename.startsWith(moduleDirectory+'/')){
            const source=readFileSync(filename,'utf8') as string
            try{
              if(parseSync(source,{babelrc:false,configFile:false,sourceType:'unambiguous'})?.program.sourceType==='module')
                return false
            }catch{/* An unparseable file stays on the CommonJS path and reports its own syntax error. */}
          }
        }
        return packageJson.type!=='module'
      }
      if(directory==='/app'||directory==='/tmp')break
      directory=dirname(directory)
    }
    return true
  }

  load(filename:string):unknown{
    const resolved=this.#resolveFile(filename)
    const external=this.loadExternal?.(resolved)
    if(external!==undefined)return external
    const cached=this.#cache.get(resolved)
    if(cached)return cached.exports
    if(!this.isCommonJS(resolved)&&!resolved.endsWith('.json'))throw Error(`Synchronous require cannot load ESM: ${resolved}`)
    const record:ModuleRecord={id:resolved,filename:resolved,exports:{},loaded:false}
    this.#cache.set(resolved,record)
    try{
      if(resolved.endsWith('.json'))record.exports=JSON.parse(readFileSync(resolved,'utf8') as string)
      else{
        const source=(readFileSync(resolved,'utf8') as string).replace(/^#![^\r\n]*/,line=>' '.repeat(line.length))
        const require=(specifier:string):unknown=>{
          if(isBuiltin(specifier))return createRequire(`file://${resolved}`)(specifier)
          if(specifier.startsWith('.'))return this.load(join(dirname(resolved),specifier))
          return this.load(this.#resolvePackage(specifier,resolved))
        }
        const evaluate=this.#functionConstructor(resolved)('exports','require','module','__filename','__dirname','Function',`${source}\n//# sourceURL=${resolved}`)
        evaluate(record.exports,require,record,resolved,dirname(resolved),this.#functionConstructor(resolved))
      }
      record.loaded=true
      return record.exports
    }catch(error){
      this.#cache.delete(resolved)
      if(isNativeProcessExit(error))throw error
      throw new Error(`CommonJS load failed: ${resolved}: ${error instanceof Error?error.message:String(error)}`,{cause:error})
    }
  }

  evaluate(source:string,filename:string,identity='[eval]'):unknown{
    const resolved=normalize(filename)
    if(!isContainerModulePath(resolved))throw Error('CommonJS eval path is outside the container filesystem')
    const record:ModuleRecord={id:identity,filename:resolved,exports:{},loaded:false}
    const require=(specifier:string):unknown=>{
      if(isBuiltin(specifier))return createRequire(`file://${resolved}`)(specifier)
      if(specifier.startsWith('.'))return this.load(join(dirname(resolved),specifier))
      return this.load(this.#resolvePackage(specifier,resolved))
    }
    const run=this.#functionConstructor(resolved)('exports','require','module','__filename','__dirname','Function',`${source}\n//# sourceURL=${resolved}`)
    run(record.exports,require,record,identity,'.',this.#functionConstructor(resolved))
    record.loaded=true
    return record.exports
  }

  #resolveFile(filename:string):string{
    const base=normalize(filename)
    if(!isContainerModulePath(base+'/'))throw Error(`CommonJS path is outside the container filesystem: ${base}`)
    for(const extension of extensions){
      const candidate=base+extension
      if(existsSync(candidate)&&statSync(candidate).isFile())return candidate
    }
    for(const extension of extensions.slice(1)){
      const candidate=join(base,'index'+extension)
      if(existsSync(candidate)&&statSync(candidate).isFile())return candidate
    }
    throw Error(`CommonJS file not found: ${base}`)
  }

  #resolvePackage(specifier:string,from:string):string{
    if(specifier.startsWith('#')){
      const target=resolveVolumePrivateImport(specifier,from,['node','require','default',...this.conditions()])
      if(target)return target
      throw Error(`Package import is unavailable to require: ${specifier} from ${from}`)
    }
    const parts=specifier.split('/')
    const name=specifier.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
    const subpath=parts.slice(name.startsWith('@')?2:1).join('/')
    let directory=dirname(from)
    while(isContainerModulePath(directory+'/')){
      const packageDirectory=join(directory,'node_modules',name)
      if(existsSync(packageDirectory)){
        const manifestPath=join(packageDirectory,'package.json')
        const manifest=existsSync(manifestPath)
          ?JSON.parse(readFileSync(manifestPath,'utf8') as string) as {main?:string;browser?:string|Record<string,string|false>;exports?:ExportTarget}
          :{}
        if(manifest.exports){
          const key=subpath?'./'+subpath:'.'
          let target:ExportTarget|undefined
          if(typeof manifest.exports==='object'&&!Array.isArray(manifest.exports)&&manifest.exports!==null){
            const entries=manifest.exports as Record<string,ExportTarget>
            if(Object.keys(entries).some(entry=>entry.startsWith('.'))){
              target=entries[key]
              if(target===undefined)for(const [pattern,value] of Object.entries(entries)){
                const star=pattern.indexOf('*')
                if(star<0)continue
                const prefix=pattern.slice(0,star),suffix=pattern.slice(star+1)
                if(key.startsWith(prefix)&&key.endsWith(suffix)){
                  const matched=key.slice(prefix.length,key.length-suffix.length)
                  const resolved=exportTarget(value,matched,this.conditions())
                  if(resolved)target=resolved
                  break
                }
              }
            }else target=manifest.exports
          }else target=manifest.exports
          const resolved=target===undefined?undefined:exportTarget(target,'',this.conditions())
          if(!resolved)throw Error(`Package export is unavailable to require: ${specifier}`)
          if(!resolved.startsWith('./'))throw Error(`Unsupported package export target: ${resolved}`)
          return join(packageDirectory,resolved)
        }
        let target=subpath||(!subpath&&this.preferBrowser&&typeof manifest.browser==='string'?manifest.browser:undefined)||manifest.main||'index'
        if(this.preferBrowser&&manifest.browser&&typeof manifest.browser==='object'){
          const mapped=manifest.browser[target.startsWith('./')?target:`./${target}`]
          if(mapped===false)throw Error(`Package browser entry is unavailable to require: ${specifier}`)
          if(typeof mapped==='string')target=mapped
        }
        return join(packageDirectory,target)
      }
      if(directory==='/app'||directory==='/tmp')break
      directory=dirname(directory)
    }
    throw Error(`Package not installed for require: ${specifier} from ${from}`)
  }
}
