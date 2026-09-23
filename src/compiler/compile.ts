import * as esbuild from 'esbuild-wasm'
import wasmUrl from 'esbuild-wasm/esbuild.wasm?url'
import { builtinModules, normalizeBuiltinSpecifier } from './builtins'
import { dirname, joinPath, normalizePath } from '../fs/path'
import type { VirtualFileSystem } from '../fs/types'

let initialization: Promise<void> | undefined

const sourceExtensions = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
]
const defaultConditions = ['worker', 'browser']
const emptyBrowserModule = '\0browser-empty:'

export function initializeCompiler(worker = true): Promise<void> {
  initialization ??= esbuild.initialize({ wasmURL: wasmUrl, worker }).catch(error=>{
    initialization=undefined
    throw error
  })
  return initialization
}

export async function stopCompiler(): Promise<void> {
  await esbuild.stop()
  initialization=undefined
}

async function resolveFile(
  fs: VirtualFileSystem,
  unresolvedPath: string,
): Promise<string | undefined> {
  const base = normalizePath(unresolvedPath)
  for (const extension of sourceExtensions) {
    const candidate = `${base}${extension}`
    if (await (fs.isFile?fs.isFile(candidate):fs.exists(candidate))) return fs.realpath?fs.realpath(candidate):candidate
  }
  for (const extension of sourceExtensions.slice(1)) {
    const candidate = joinPath(base, `index${extension}`)
    if (await (fs.isFile?fs.isFile(candidate):fs.exists(candidate))) return fs.realpath?fs.realpath(candidate):candidate
  }
  return undefined
}

function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith('.tsx')) return 'tsx'
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts'))
    return 'ts'
  if (path.endsWith('.jsx')) return 'jsx'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.css')) return 'text'
  if (path.endsWith('.wasm')) return 'binary'
  return 'js'
}

function splitPackageSpecifier(specifier: string): {
  name: string
  subpath: string
} {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0]
  const remainder = parts.slice(name.startsWith('@') ? 2 : 1).join('/')
  return { name, subpath: remainder ? `./${remainder}` : '.' }
}

type ExportTarget =
  string | null | ExportTarget[] | { [condition: string]: ExportTarget }

function resolveConditionalTarget(
  target: ExportTarget,
  conditions: Set<string>,
  wildcard?: string,
): string | undefined {
  if (typeof target === 'string') {
    return wildcard === undefined ? target : target.replaceAll('*', wildcard)
  }
  if (target === null) return undefined
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveConditionalTarget(candidate, conditions, wildcard)
      if (resolved) return resolved
    }
    return undefined
  }
  for (const [condition, candidate] of Object.entries(target)) {
    if (condition === 'default' || conditions.has(condition)) {
      const resolved = resolveConditionalTarget(candidate, conditions, wildcard)
      if (resolved) return resolved
    }
  }
  return undefined
}

function resolveExports(
  exportsField: ExportTarget,
  subpath: string,
  conditions: Set<string>,
): string | undefined {
  if (
    typeof exportsField === 'string' ||
    exportsField === null ||
    Array.isArray(exportsField)
  ) {
    return subpath === '.'
      ? resolveConditionalTarget(exportsField, conditions)
      : undefined
  }

  const keys = Object.keys(exportsField)
  const isSubpathMap = keys.some((key) => key.startsWith('.'))
  if (!isSubpathMap) {
    return subpath === '.'
      ? resolveConditionalTarget(exportsField, conditions)
      : undefined
  }

  if (subpath in exportsField) {
    return resolveConditionalTarget(exportsField[subpath], conditions)
  }

  const patterns = keys
    .filter((key) => key.includes('*'))
    .sort((left, right) => right.length - left.length)
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split('*')
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    const wildcard = subpath.slice(
      prefix.length,
      subpath.length - suffix.length,
    )
    return resolveConditionalTarget(exportsField[pattern], conditions, wildcard)
  }
  return undefined
}

async function findPackageRoot(
  fs: VirtualFileSystem,
  packageName: string,
  importer: string,
): Promise<string | undefined> {
  let directory = dirname(importer || '/')
  while (true) {
    const candidate = joinPath(directory, 'node_modules', packageName)
    if (await fs.exists(joinPath(candidate, 'package.json'))) return candidate
    if (directory === '/') return undefined
    directory = dirname(directory)
  }
}

async function resolvePrivateImport(
  fs: VirtualFileSystem, specifier: string, importer: string, kind: string, environmentConditions: string[],
): Promise<string> {
  if(specifier==='#'||specifier.startsWith('#/'))throw Error(`Invalid package import '${specifier}'`)
  let directory=dirname(importer)
  while(true){
    if(directory.endsWith('/node_modules'))throw Error(`No package scope for import '${specifier}'`)
    const manifest=joinPath(directory,'package.json')
    if(await fs.exists(manifest)){
      const metadata=JSON.parse(await fs.readText(manifest))
      const imports=metadata.imports as Record<string,ExportTarget>|undefined
      let target:ExportTarget|undefined=imports?.[specifier],wildcard:string|undefined
      if(target===undefined&&imports){
        const pattern=Object.keys(imports).filter(key=>key.includes('*')).sort((a,b)=>{
          const prefix=b.indexOf('*')-a.indexOf('*');return prefix||b.length-a.length
        }).find(key=>{
          const [prefix,suffix]=key.split('*')
          return specifier.startsWith(prefix)&&specifier.endsWith(suffix)&&specifier.length>=prefix.length+suffix.length
        })
        if(pattern){
          const [prefix,suffix]=pattern.split('*')
          wildcard=specifier.slice(prefix.length,specifier.length-suffix.length)
          target=imports[pattern]
        }
      }
      const resolved=target===undefined?undefined:resolveConditionalTarget(target,new Set([...environmentConditions,kind==='require-call'?'require':'import','default']),wildcard)
      if(!resolved)throw Error(`Package import '${specifier}' is not defined in '${manifest}'`)
      if(resolved.startsWith('./')){
        if(resolved.slice(2).split('/').some(part=>{
          const decoded=decodeURIComponent(part)
          return decoded==='.'||decoded==='..'||decoded==='node_modules'||decoded.includes('/')||decoded.includes('\\')
        }))throw Error(`Invalid package import target '${resolved}'`)
        return joinPath(directory,resolved)
      }
      if(resolved.startsWith('.')||resolved.startsWith('/')||resolved.startsWith('#'))throw Error(`Invalid package import target '${resolved}'`)
      return resolved
    }
    if(directory==='/')throw Error(`No package scope for import '${specifier}'`)
    directory=dirname(directory)
  }
}

async function browserMapping(fs:VirtualFileSystem,specifier:string,importer:string):Promise<string|false|undefined>{
  let directory=dirname(importer)
  while(true){
    const manifest=joinPath(directory,'package.json')
    if(await fs.exists(manifest)){
      const {browser}=JSON.parse(await fs.readText(manifest))
      if(!browser||typeof browser!=='object')return undefined
      const absolute=specifier.startsWith('.')?joinPath(dirname(importer),specifier):specifier.startsWith('/')?specifier:undefined
      const key=absolute?.startsWith(directory+'/')?'./'+absolute.slice(directory.length+1):specifier
      const target=browser[key]??browser[key+'.js']
      if(target===false)return false
      if(typeof target==='string')return target.startsWith('.')?joinPath(directory,target):target
      return undefined
    }
    if(directory==='/')return undefined
    directory=dirname(directory)
  }
}

async function resolvePackage(
  fs: VirtualFileSystem,
  specifier: string,
  importer: string,
  kind: string,
  environmentConditions: string[],
): Promise<string | undefined> {
  const { name, subpath } = splitPackageSpecifier(specifier)
  const packageRoot = await findPackageRoot(fs, name, importer)
  if (!packageRoot) return undefined

  const packageJson = JSON.parse(
    await fs.readText(joinPath(packageRoot, 'package.json')),
  ) as {
    exports?: ExportTarget
    browser?: string | Record<string, string | false>
    module?: string
    main?: string
  }
  const conditions = new Set([...environmentConditions,kind === 'require-call' ? 'require' : 'import','default'])
  let target: string | undefined
  if (packageJson.exports !== undefined) {
    target = resolveExports(packageJson.exports, subpath, conditions)
    if (!target)
      throw new Error(`Package '${name}' does not export '${subpath}'`)
  } else if (subpath !== '.') {
    target = subpath.slice(2)
  } else {
    target =
      conditions.has('browser') && typeof packageJson.browser === 'string'
        ? packageJson.browser
        : (packageJson.module ?? packageJson.main ?? 'index.js')
  }

  if (packageJson.exports !== undefined && !target.startsWith('./')) {
    throw new Error(`Package '${name}' resolved to invalid target '${target}'`)
  }
  const resolvedTarget = joinPath(packageRoot, target)
  if (!resolvedTarget.startsWith(packageRoot + '/'))
    throw new Error(`Package '${name}' target escapes its package`)
  if(conditions.has('browser')){
    const mapped=await browserMapping(fs,resolvedTarget,joinPath(packageRoot,'index.js'))
    if(mapped===false)return emptyBrowserModule+resolvedTarget
    if(mapped?.startsWith('/'))return resolveFile(fs,mapped)
  }
  return resolveFile(fs, resolvedTarget)
}

export interface CompileResult {
  code: string
  warnings: string[]
}

export async function compileProject(
  fs: VirtualFileSystem,
  entryPoint = '/src/server.ts',
  options: {conditions?: string[];compact?:boolean} = {},
): Promise<CompileResult> {
  await initializeCompiler()

  const result = await esbuild.build({
    absWorkingDir: '/',
    bundle: true,
    entryPoints: [normalizePath(entryPoint)],
    format: 'esm',
    jsx: 'automatic',
    platform: 'browser',
    sourcemap: false,
    // Remove formatting, not identifiers or syntax. Large compiler packages
    // otherwise spend the guest source quota on generated indentation.
    minifyWhitespace: options.compact ?? false,
    target: ['es2022'],
    define: {
      'process.env': 'globalThis.__webContainerHost.env',
    },
    write: false,
    plugins: [
      {
        name: 'virtual-filesystem',
        setup(build) {
          build.onResolve({ filter: /.*/ }, async (args) => {
            if((options.conditions??defaultConditions).includes('browser')&&args.importer){
              const mapped=await browserMapping(fs,args.path,args.importer)
              if(mapped===false)return {path:args.path,namespace:'browser-empty'}
              if(mapped)args={...args,path:mapped}
            }
            if(args.path.startsWith('#')){
              try{
                args={...args,path:await resolvePrivateImport(fs,args.path,args.importer,args.kind,options.conditions??defaultConditions)}
              }catch(error){return {errors:[{text:String(error)}]}}
            }
            const builtin = normalizeBuiltinSpecifier(args.path)
            if (builtin)
              return {
                path: builtin,
                namespace:
                  args.kind === 'require-call' ? 'builtin-commonjs' : 'builtin',
              }
            if (args.path.startsWith('node:'))
              return {
                errors: [{ text: `Unsupported Node builtin '${args.path}'` }],
              }

            if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
              try {
                const resolved = await resolvePackage(
                  fs,
                  args.path,
                  args.importer,
                  args.kind,
                  options.conditions ?? defaultConditions,
                )
                if (resolved) return { path: resolved, namespace: resolved.startsWith(emptyBrowserModule)?'browser-empty':'vfs' }
                return {
                  errors: [{ text: `Package '${args.path}' is not installed` }],
                }
              } catch (error) {
                return {
                  errors: [
                    {
                      text:
                        error instanceof Error ? error.message : String(error),
                    },
                  ],
                }
              }
            }

            const unresolved = args.path.startsWith('/')
              ? args.path
              : joinPath(dirname(args.importer || '/'), args.path)
            const resolved = await resolveFile(fs, unresolved)
            if (!resolved) {
              return {
                errors: [
                  {
                    text: `Could not resolve '${args.path}' from '${args.importer || '/'}'`,
                  },
                ],
              }
            }
            return { path: resolved, namespace: 'vfs' }
          })

          build.onLoad({ filter: /.*/, namespace: 'builtin' }, (args) => ({
            contents: builtinModules[args.path],
            loader: 'js',
          }))
          build.onLoad({filter:/.*/,namespace:'browser-empty'},()=>({contents:'module.exports = {};',loader:'js'}))
          build.onLoad(
            { filter: /.*/, namespace: 'builtin-commonjs' },
            (args) => ({
              contents: `import * as builtin from ${JSON.stringify(args.path)}; module.exports = builtin.default ?? builtin;`,
              loader: 'js',
            }),
          )

          build.onLoad({ filter: /.*/, namespace: 'vfs' }, async (args) => ({
            contents: args.path.endsWith('.wasm')
              ? await fs.readFile(args.path)
              : await fs.readText(args.path),
            loader: loaderFor(args.path),
            resolveDir: dirname(args.path),
          }))
        },
      },
    ],
  })

  const output = result.outputFiles[0]
  if (!output) throw new Error('Compiler did not produce JavaScript output')

  return {
    code: output.text,
    warnings: result.warnings.map((warning) => warning.text),
  }
}
