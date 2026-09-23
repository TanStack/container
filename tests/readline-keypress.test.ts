import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {PassThrough} from 'node:stream'
import {emitKeypressEvents as native} from 'node:readline'
import {transformSync} from 'esbuild'
const module={exports:{} as any}
new Function('require','module','exports',transformSync(readFileSync('src/sandbox/guest-readline.js','utf8'),{format:'cjs'}).code)(createRequire(import.meta.url),module,module.exports)
const guest=module.exports.emitKeypressEvents
function observe(install:any){const stream=new PassThrough(),events:any[]=[];install(stream);install(stream);stream.on('keypress',(text,key)=>events.push({text,key}));for(const chunk of ['aR\x03\r\t\x7f','\x1b[','A','\x1b[D','é'])stream.write(chunk);return {events,stream}}
it('matches native Vitest watch shortcuts, arrows, controls and split escape input',()=>{
 const actual=observe(guest),expected=observe(native)
 expect(actual.events).toEqual(expected.events)
 actual.stream.destroy();expected.stream.destroy()
})
it('does not pretend pipes are terminals and releases its data listener after cleanup',()=>{
 const {stream}=observe(guest)
 expect(Reflect.get(stream,'isTTY')).toBeUndefined()
 stream.removeAllListeners('keypress')
 expect(stream.listenerCount('data')).toBe(0)
 stream.destroy()
})
