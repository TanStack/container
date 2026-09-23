import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,cpSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {stageGuestSampling} from '../scripts/stage-guest-sampling.mjs'
import {stageCallDepth} from '../scripts/stage-call-depth.mjs'
import {stageOpcodePatterns} from '../scripts/stage-opcode-patterns.mjs'
import {stageInterpreterFrames} from '../scripts/stage-interpreter-frames.mjs'
import {stageInterpreterMachine} from '../scripts/stage-interpreter-machine.mjs'
import {stageBatchedInterpreterMachine} from '../scripts/stage-interpreter-machine-batched.mjs'

const upstream=resolve('.toolchains/quickjs-emscripten/vendor/quickjs')
const original=readFileSync(join(upstream,'quickjs.c'),'utf8')
function fixture(source=original){const path=join(mkdtempSync(join(tmpdir(),'qjs-guest-sampling-stage-')),'quickjs.c');writeFileSync(path,source);return path}

test('sampling stage replaces exactly seven existing branch polls and owns storage per runtime',()=>{
  const file=fixture();stageGuestSampling(file);const source=readFileSync(file,'utf8')
  assert.equal(source.split('unlikely(qjs_guest_sampling_poll(ctx, b, pc))').length-1,7)
  assert.match(source,/struct QJSGuestSampling \*guest_sampling/)
  assert.match(source,/void JS_FreeRuntime\(JSRuntime \*rt\)\n\{\n#ifdef QJS_GUEST_SAMPLING\n    qjs_guest_sampling_dispose\(rt\)/)
  assert.match(source,/#define qjs_guest_sampling_poll\(ctx, b, pc\) js_poll_interrupts\(ctx\)/)
  const before=readFileSync(file);assert.throws(()=>stageGuestSampling(file),/already staged/);assert.deepEqual(readFileSync(file),before)
})
test('sampling stage rejects changed polls or runtime anchors without writing',()=>{
  for(const source of [original.replace('CASE(OP_goto):','CASE(OP_goto_changed):'),original.replace('struct JSRuntime {','struct JSRuntime /*changed*/ {'),original.replace('void JS_FreeRuntime(JSRuntime *rt)','void JS_FreeRuntime(JSRuntime *changed)')]){
    const file=fixture(source),before=readFileSync(file)
    assert.throws(()=>stageGuestSampling(file),/Unexpected guest sampling/)
    assert.deepEqual(readFileSync(file),before)
  }
})
test('sampling stage composes after ordinary and batched interpreter staging',()=>{
  for(const stage of [stageInterpreterMachine,stageBatchedInterpreterMachine]){
    const file=fixture();stageCallDepth(file);stageOpcodePatterns(file);stageInterpreterFrames(file);stage(file);stageGuestSampling(file)
    assert.equal(readFileSync(file,'utf8').split('unlikely(qjs_guest_sampling_poll(ctx, b, pc))').length-1,7)
  }
})
test('build integration is opt-in with separate artifacts and unchanged default exports',()=>{
  const source=readFileSync('scripts/build-quickjs-als.mjs','utf8')
  for(const text of ["const guestSampling=process.argv.includes('--guest-sampling')","+(guestSampling?'-guest-sampling':'')","if(guestSampling)fiberExports.push('_QJS_GuestSamplingReset'","...(guestSampling?['-DQJS_GUEST_SAMPLING']:[])","...(guestSampling?{guestSampling:{experimental:true,maxSamples:512,intervalMs:20,functionBytes:96,filenameBytes:192,retention:'latest512'"] )assert.ok(source.includes(text),text)
})
test('native sampler preserves results and cancellation, bounds retention, isolates runtimes and owns text',()=>{
  const directory=mkdtempSync(join(tmpdir(),'qjs-guest-sampling-native-')),qjs=join(directory,'quickjs')
  cpSync(upstream,qjs,{recursive:true});stageGuestSampling(join(qjs,'quickjs.c'))
  for(const enabled of [false,true]){
    const exe=join(directory,enabled?'enabled':'disabled')
    const args=['-O1','-g','-fsanitize=address','-fno-omit-frame-pointer','-D_GNU_SOURCE','-DCONFIG_VERSION="sampling-test"',...(enabled?['-DQJS_GUEST_SAMPLING']:[]),'-I'+qjs,resolve('tests/fixtures/guest-sampling-native.c'),...['dtoa','libregexp','libunicode','cutils'].map(n=>join(qjs,n+'.c')),'-lm','-o',exe]
    const build=spawnSync(process.env.CC??'cc',args,{encoding:'utf8',timeout:120000})
    assert.equal(build.status,0,build.stdout+build.stderr)
    const run=spawnSync(exe,[],{encoding:'utf8',timeout:60000,env:{...process.env,ASAN_OPTIONS:'abort_on_error=1'}})
    assert.equal(run.status,0,run.stdout+run.stderr)
    assert.equal(run.stderr,'')
    assert.match(run.stdout,enabled?/sampling ok/:/disabled baseline ok/)
  }
})
