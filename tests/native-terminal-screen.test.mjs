import assert from 'node:assert/strict'
import test from 'node:test'
import {nativeTerminalScreen} from '../scripts/native-terminal-screen.mjs'

function control(height=300){
  const events=[]
  const screen={hover:async()=>events.push('hover'),boundingBox:async()=>({height}),
    evaluate:async callback=>{assert.match(String(callback),/requestAnimationFrame/);events.push('frames')}}
  const terminal={locator(selector){
    events.push(selector)
    if(selector==='.xterm-screen')return screen
    assert.equal(selector,'.xterm-rows')
    return {textContent:async()=>'visible rows'}
  }}
  const page={mouse:{wheel:async(x,y)=>events.push({x,y})}}
  return {events,view:nativeTerminalScreen(terminal,page)}
}

test('terminal wheel targets the visible screen and uses its measured height',async()=>{
  const {view,events}=control()
  assert.equal(await view.read(),'visible rows')
  await view.scroll(-1);await view.scroll(1)
  assert.deepEqual(events,['.xterm-screen','.xterm-rows','hover',{x:0,y:-150},'frames','hover',{x:0,y:150},'frames'])
})

test('terminal wheel has a minimum distance and rejects invalid directions',async()=>{
  const {view,events}=control(20)
  await view.scroll(-1)
  assert.ok(events.some(event=>event.y===-24))
  for(const direction of [0,2,NaN])await assert.rejects(view.scroll(direction))
})

test('terminal wheel refuses an invisible screen',async()=>{
  const {view,events}=control(0)
  await assert.rejects(view.scroll(-1),/not visible/)
  assert.ok(!events.some(event=>typeof event==='object'))
})
