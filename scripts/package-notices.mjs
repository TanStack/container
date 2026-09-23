import {readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {supplementalPackageNotice} from './supplemental-package-notices.mjs'

export function readPackageNotices(directory){
  const files=readdirSync(directory,{withFileTypes:true})
    .filter(entry=>/^(license|licence|copying|notice)([._-]|$)/i.test(entry.name))
    .sort((a,b)=>a.name.localeCompare(b.name))
  return files.map(entry=>{
    if(!entry.isFile())throw Error('Expected a regular package notice file: '+join(directory,entry.name))
    return readFileSync(join(directory,entry.name),'utf8')
  }).join('\n')
}

/** Keep independently bundled versions, while repeated inputs share one entry. */
export function addPackageNotices(packages,directory,pkg){
  if(typeof pkg.name!=='string'||!pkg.name||typeof pkg.version!=='string'||!pkg.version)throw Error('Missing package notice identity: '+directory)
  const key=pkg.name+'@'+pkg.version
  if(!packages.has(key)){
    const installed=readPackageNotices(directory)
    const supplemental=installed?undefined:supplementalPackageNotice(directory,pkg)
    packages.set(key,{
      name:pkg.name,version:pkg.version,license:pkg.license,
      notices:installed||(supplemental?`Upstream notice: ${supplemental.source}\n${supplemental.text}`:''),
    })
  }
}
