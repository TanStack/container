import {parse} from 'parse5'

/** Insert before guest scripts without reserializing source or hydration data. */
export function injectPreviewScripts(source:string,scripts:string){
  const document=parse(source,{sourceCodeLocationInfo:true})
  const html=document.childNodes.find(node=>node.nodeName==='html')
  let offset=0
  if(html&&'childNodes' in html){
    const head=html.childNodes.find(node=>node.nodeName==='head')
    if(head?.sourceCodeLocation&&'startTag' in head.sourceCodeLocation)
      offset=head.sourceCodeLocation.startTag?.endOffset??0
    else if(html.sourceCodeLocation&&'startTag' in html.sourceCodeLocation)
      offset=html.sourceCodeLocation.startTag?.endOffset??0
    else{
      const doctype=document.childNodes.find(node=>node.nodeName==='#documentType')
      offset=doctype?.sourceCodeLocation?.endOffset??0
    }
  }
  return source.slice(0,offset)+scripts+source.slice(offset)
}
