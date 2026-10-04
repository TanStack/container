import {realpath} from 'node:fs/promises'
import {resolve,sep} from 'node:path'

export function canonicalCompilerPackageRoot(directory){
  return realpath(resolve(directory))
}

export function isCompilerPackageImporter(root,importer){
  return importer.startsWith(root+sep)
}
