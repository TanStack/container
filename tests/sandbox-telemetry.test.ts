import {describe,it,expect} from 'vitest'
import {SandboxTelemetry} from '../src/sdk/telemetry'

describe('SandboxTelemetry',()=>{
  it('keeps deterministic JSON-safe events in a bounded ring',()=>{
    const telemetry=new SandboxTelemetry({capacity:2})
    telemetry.record({type:'file.write',path:'/a',bytes:1})
    telemetry.record({type:'file.mkdir',path:'/b'})
    telemetry.record({type:'session.close'})
    expect(telemetry.events()).toEqual([
      {sequence:2,type:'file.mkdir',path:'/b'},
      {sequence:3,type:'session.close'},
    ])
    expect(telemetry.dropped).toBe(1)
    expect(JSON.parse(JSON.stringify(telemetry.events()))).toEqual(telemetry.events())
  })

  it('returns isolated copies and supports drain and clear',()=>{
    const telemetry=new SandboxTelemetry({capacity:2})
    telemetry.record({type:'process.start',command:'node',args:['app.js']})
    const copy=telemetry.events();copy[0]={sequence:99,type:'session.close'}
    expect(telemetry.drain()).toEqual([{sequence:1,type:'process.start',command:'node',args:['app.js']}])
    expect(telemetry.events()).toEqual([])
    telemetry.record({type:'session.close'});telemetry.clear()
    expect(telemetry.events()).toEqual([]);expect(telemetry.dropped).toBe(0)
  })

  it('rejects unbounded capacities',()=>{
    expect(()=>new SandboxTelemetry({capacity:0})).toThrow('between 1 and 10000')
    expect(()=>new SandboxTelemetry({capacity:10_001})).toThrow('between 1 and 10000')
  })
})
