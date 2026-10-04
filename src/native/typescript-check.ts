import type * as TypeScript from 'typescript'
import type {Volume} from 'memfs'
import {normalize} from '../vite-browser/node-path'
import type {TypeScriptDiagnostic} from './typescript-diagnostic'

/** Type-check the mounted project with its installed TypeScript package. */
export function checkTypeScript(ts:typeof TypeScript,volume:Pick<Volume,
  'readFileSync'|'existsSync'|'statSync'|'readdirSync'|'realpathSync'>,configPath='/app/tsconfig.json',
  libDirectory='/app/node_modules/typescript/lib'):{diagnostics:TypeScriptDiagnostic[]}{
  const currentDirectory='/app'
  const path=(value:string)=>normalize(value)
  const readFile=(value:string):string|undefined=>{
    try{return volume.readFileSync(path(value),'utf8') as string}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  }
  const fileExists=(value:string)=>volume.existsSync(path(value))&&volume.statSync(path(value)).isFile()
  const directoryExists=(value:string)=>volume.existsSync(path(value))&&volume.statSync(path(value)).isDirectory()
  const getFileSystemEntries=(value:string)=>{
    if(!directoryExists(value))return {files:[],directories:[]}
    const entries=volume.readdirSync(path(value),{withFileTypes:true}) as Array<{
      name:string;isFile():boolean;isDirectory():boolean
    }>
    return {
      files:entries.filter(entry=>entry.isFile()).map(entry=>entry.name),
      directories:entries.filter(entry=>entry.isDirectory()).map(entry=>entry.name),
    }
  }
  const getDirectories=(value:string)=>getFileSystemEntries(value).directories
  const realpath=(value:string)=>{
    try{return String(volume.realpathSync(path(value)))}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return path(value);throw error}
  }
  const matcher=ts as typeof TypeScript & {matchFiles:(root:string,extensions:readonly string[]|undefined,
    excludes:readonly string[]|undefined,includes:readonly string[]|undefined,caseSensitive:boolean,
    currentDirectory:string,depth:number|undefined,getEntries:typeof getFileSystemEntries,realpath:(path:string)=>string)=>string[]}
  const readDirectory:TypeScript.ParseConfigHost['readDirectory']=(root,extensions,excludes,includes,depth)=>
    matcher.matchFiles(path(root),extensions,excludes,includes,true,currentDirectory,depth,getFileSystemEntries,realpath)
  const config=ts.readConfigFile(configPath,readFile)
  const configErrors=config.error?[config.error]:[]
  const parsed=ts.parseJsonConfigFileContent(config.config??{},
    {useCaseSensitiveFileNames:true,readDirectory,fileExists,readFile},currentDirectory,{noEmit:true},configPath)
  const options={...parsed.options,noEmit:true}
  const host:TypeScript.CompilerHost={
    getSourceFile(filename,languageVersion,onError){
      const source=readFile(filename)
      if(source===undefined){onError?.(`File not found: ${filename}`);return}
      return ts.createSourceFile(filename,source,languageVersion)
    },
    getDefaultLibFileName:options=>`${libDirectory}/${ts.getDefaultLibFileName(options)}`,
    writeFile(){throw Error('TypeScript noEmit check attempted to write a file')},
    getCurrentDirectory:()=>currentDirectory,
    getDirectories,
    fileExists,
    readFile,
    directoryExists,
    realpath,
    getCanonicalFileName:filename=>filename,
    useCaseSensitiveFileNames:()=>true,
    getNewLine:()=>"\n",
  }
  const program=ts.createProgram(parsed.fileNames,options,host)
  const diagnostics=[...configErrors,...parsed.errors,...ts.getPreEmitDiagnostics(program)]
  return {diagnostics:diagnostics.map(diagnostic=>{
    const location=diagnostic.file&&diagnostic.start!==undefined
      ?diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start):undefined
    return {code:diagnostic.code,category:diagnostic.category,
      message:ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n'),
      ...(diagnostic.file?{file:diagnostic.file.fileName}:{}),
      ...(location?{line:location.line+1,column:location.character+1}:{})}
  })}
}
