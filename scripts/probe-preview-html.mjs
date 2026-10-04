import assert from 'node:assert/strict'
import {parse} from 'parse5'
import {injectPreviewScripts} from '../src/sandbox/preview-html.ts'

const script='<script src="/__sandbox/inspect.js"></script>'
const cases=[
  '<!doctype html><html><head><script>window.payload="<head>"</script></head><body>hello</body></html>',
  '<!doctype html><html><body><h1>Astro 42</h1></body></html>',
  '<!doctype html><title>Implicit</title><main>hello</main>',
  '<!-- <head>fake</head> --><!doctype html><html><head data-value=">"><title>Title</title></head><body>hello</body></html>',
  '<main>fragment</main>',
]
for(const source of cases){
  const injected=injectPreviewScripts(source,script)
  const index=injected.indexOf(script)
  assert.equal(injected.slice(0,index)+injected.slice(index+script.length),source)
  const document=parse(injected)
  const html=document.childNodes.find(node=>node.nodeName==='html')
  const head=html.childNodes.find(node=>node.nodeName==='head')
  assert.ok(head.childNodes.some(node=>node.nodeName==='script'&&node.attrs.some(attr=>attr.name==='src'&&attr.value==='/__sandbox/inspect.js')))
  assert.equal(document.mode,parse(source).mode,'Injection must preserve quirks mode')
}
console.log(`${cases.length} preview HTML insertion cases matched`)
