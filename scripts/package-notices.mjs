import {readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {supplementalPackageNotice} from './supplemental-package-notices.mjs'

export function readmeMITNotice(text){
  const headings=[...text.matchAll(/^#{1,6}[ \t]+(?:license|licence)[ \t]*#*[ \t]*$/gim)]
  for(const heading of headings){
    const rest=text.slice(heading.index+heading[0].length)
    const next=rest.search(/^#{1,6}[ \t]+/m)
    const section=(next<0?rest:rest.slice(0,next)).trim()
    const normalized=section.replace(/\s+/g,' ').toLowerCase()
    // A badge, SPDX identifier or link is not a copy of the license. Keep the
    // package's actual text only when all MIT permission and warranty clauses
    // are present, including its own copyright notice.
    const required=['mit','copyright','permission is hereby granted, free of charge',
      'to deal in the software without restriction',
      'use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'the above copyright notice and this permission notice shall be included',
      'the software is provided "as is", without warranty of any kind',
      'merchantability, fitness for a particular purpose and noninfringement',
      'in no event shall the authors or copyright holders be liable',
      'arising from, out of or in connection with the software or the use or other dealings in the software']
    const attribution=/^copyright[ \t]+(?!(?:notice|holders)\b)[^\r\n]+/im.test(section)
    if(attribution&&required.every(clause=>normalized.includes(clause)))return section
  }
  return ''
}

export function readPackageNotices(directory){
  const entries=readdirSync(directory,{withFileTypes:true})
  const primary=/^(license|licence|copying|notice)([._-]|$)/i
  const thirdParty=/^third[._ -]?party[._ -](?:licen[cs]es?|notices?)([._ -]|$)/i
  const files=entries
    .filter(entry=>primary.test(entry.name)||thirdParty.test(entry.name))
    .sort((a,b)=>a.name.localeCompare(b.name))
  const notices=files.map(entry=>{
    if(!entry.isFile())throw Error('Expected a regular package notice file: '+join(directory,entry.name))
    return readFileSync(join(directory,entry.name),'utf8')
  }).join('\n')
  if(files.some(entry=>primary.test(entry.name)))return notices
  const readme=entries.find(entry=>/^readme(?:\.md|\.markdown)?$/i.test(entry.name))
  if(!readme)return notices
  if(!readme.isFile())throw Error('Expected a regular package README file: '+join(directory,readme.name))
  // A bundled dependency notice does not replace the package's own README
  // license. Retain both when the package uses that form of attribution.
  return [readmeMITNotice(readFileSync(join(directory,readme.name),'utf8')),notices].filter(Boolean).join('\n')
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
