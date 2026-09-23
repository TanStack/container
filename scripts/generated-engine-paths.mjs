import {basename} from 'node:path'

export function normalizeCompilerSourcePaths(text,sourceDirectory){
  return text.replaceAll(sourceDirectory,'/sources/quickjs-emscripten')
}

export function normalizeInspectionWrapperPaths(text,metafileInputs,stagingDirectory){
  const stagedDirectoryName=basename(stagingDirectory)
  const marker=`/${stagedDirectoryName}/inspection-core/`
  const stagedInput=metafileInputs.find(input=>input.includes(marker))
  if(!stagedInput)throw Error(`esbuild metadata did not identify the staged inspection wrapper ${stagedDirectoryName}`)
  const stagedWrapperPath=stagedInput.slice(0,stagedInput.indexOf('/inspection-core/'))
  const normalized=text.replaceAll(stagedWrapperPath,'/sources/quickjs-staged')
  if(normalized===text||normalized.includes(stagedDirectoryName)){
    throw Error('Failed to remove the temporary inspection wrapper path from the engine bundle')
  }
  return normalized
}
