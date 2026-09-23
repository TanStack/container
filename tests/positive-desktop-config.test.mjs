import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,lstatSync} from 'node:fs'

const suite=JSON.parse(readFileSync(new URL('../compat/positive-desktop-suite.json',import.meta.url),'utf8'))
const root=new URL('./',import.meta.url)

test('positive desktop suite is an explicit, unique allowlist of ordinary compatibility specs',()=>{
  assert.equal(suite.purpose,'Ordinary desktop application compatibility and public API conformance only')
  assert.deepEqual(suite.excludedCategories,[
    'adversarial behavior','sandbox escape attempts','resource exhaustion','infinite loops','hostile payloads','recovery under attack',
  ])
  assert.ok(suite.specs.length>=25)
  assert.equal(new Set(suite.specs).size,suite.specs.length)
  for(const spec of suite.specs){
    assert.match(spec,/^[a-z0-9-]+\/[a-z0-9-]+\.spec\.ts$/)
    const stat=lstatSync(new URL(spec,root))
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),`${spec} must be a regular test file`)
    for(const pattern of suite.excludedPathPatterns)assert.ok(!spec.includes(pattern),`${spec} matches excluded category ${pattern}`)
  }
})

test('included test titles cannot claim excluded behavior',()=>{
  const excluded=suite.excludedTitlePatterns.map(pattern=>new RegExp(pattern,'i'))
  for(const spec of suite.specs){
    const source=readFileSync(new URL(spec,root),'utf8')
    const titles=[...source.matchAll(/\btest\s*\(\s*([`'"])(.*?)\1/gs)].map(match=>match[2])
    for(const title of titles)for(const pattern of excluded)assert.doesNotMatch(title,pattern,`${spec}: ${title}`)
  }
})

test('the config consumes the guarded allowlist and fixes deterministic execution settings',()=>{
  const source=readFileSync(new URL('../playwright.positive-desktop.config.ts',import.meta.url),'utf8')
  assert.match(source,/positive-desktop-suite\.json/)
  assert.match(source,/testMatch:suite\.specs/)
  assert.match(source,/workers:1/)
  assert.match(source,/fullyParallel:false/)
  assert.match(source,/retries:0/)
  assert.match(source,/forbidOnly:true/)
})
