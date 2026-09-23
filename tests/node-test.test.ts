import {test,expect} from 'vitest'
import {spawnSync} from 'node:child_process'

const run=(body:string)=>spawnSync(process.execPath,['--input-type=module','-e',`import {test,describe,before,beforeEach,afterEach} from './src/sandbox/guest-node-test.js';import assert from 'node:assert/strict';${body}`],{encoding:'utf8',timeout:5000})
test('guest node:test runs hooks, async tests, skip and todo with deterministic TAP',()=>{
  const result=run(`let n=0;describe('suite',()=>{before(()=>n++);beforeEach(()=>n++);afterEach(()=>n++);test('sync',()=>assert.equal(n,2));test('async',async()=>{await 0;assert.equal(n,4)});test.skip('skip',()=>assert.fail());test.todo('todo')})`)
  expect(result.status,result.stderr).toBe(0)
  expect(result.stdout).toBe('TAP version 13\nok 1 - sync\nok 2 - async\nok 3 - skip # SKIP\nok 4 - todo # TODO\n1..4\n# tests 4\n# pass 2\n# fail 0\n# skipped 1\n# todo 1\n')
})
test('guest node:test only selection and assertion failure set process status',()=>{
  const only=run(`test('wrong',()=>assert.fail());test.only('chosen',()=>assert.equal(1,1))`)
  expect(only.status,only.stderr).toBe(0);expect(only.stdout).not.toContain('wrong');expect(only.stdout).toContain('ok 1 - chosen')
  const failed=run(`test('broken',()=>assert.equal(1,2))`)
  expect(failed.status).toBe(1);expect(failed.stdout).toContain('not ok 1 - broken');expect(failed.stdout).toContain('code: ERR_ASSERTION')
})
test('node:test callable default carries the named APIs used by the builtin module bridge',()=>{
  const result=run(`const {default:callable}=await import('./src/sandbox/guest-node-test.js');
    assert.equal(callable,callable.test);assert.equal(callable.it,callable.test);
    assert.equal(callable.describe,describe);assert.equal(callable.suite,describe);
    assert.equal(callable.before,before);assert.equal(callable.beforeEach,beforeEach);assert.equal(callable.afterEach,afterEach);
    for(const name of ['test','it','describe','suite','before','after','beforeEach','afterEach'])assert.equal(typeof callable[name],'function');
    callable.test('bridged named test',()=>assert.equal(2+2,4));`)
  expect(result.status,result.stderr).toBe(0)
  expect(result.stdout).toContain('ok 1 - bridged named test')
})
