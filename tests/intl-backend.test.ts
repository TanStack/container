import {test,expect} from 'vitest'
import {IntlDateTimeBackend} from '../src/sandbox/intl-backend'

test('number formatters share owner limits with date formatters and close together',()=>{
  const backend=new IntlDateTimeBackend(2)
  const id=backend.call('number:create',[['en-US'],{minimumFractionDigits:2,maximumFractionDigits:2}])
  expect(backend.call('number:format',[id,{kind:'number',value:'-0'}])).toBe('-0.00')
  expect(backend.call('number:format',[id,{kind:'bigint',value:'9007199254740993'}])).toBe('9,007,199,254,740,993.00')
  expect(()=>backend.call('number:format',[id,{kind:'object',value:'0'}])).toThrow()
  expect(()=>backend.call('number:create',[[],{invalid:true}])).toThrow()
  backend.call('create',[[],{}]);expect(backend.size).toBe(2)
  expect(()=>backend.call('number:create',[[],{}])).toThrow('limit')
  backend.close();expect(backend.size).toBe(0)
  expect(()=>backend.call('number:format',[id,{kind:'number',value:'1'}])).toThrow('closed')
})

test('date-time backend returns copied data from real locale formatting',()=>{
  const backend=new IntlDateTimeBackend(),options={timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'} as const
  const native=new Intl.DateTimeFormat('en-GB',options),id=backend.call('create',[['en-GB'],options])
  expect(backend.call('format',[id,0])).toBe(native.format(0))
  expect(backend.call('parts',[id,0])).toEqual(native.formatToParts(0))
  expect(backend.call('range',[id,0,86400000])).toBe(native.formatRange(0,86400000))
  expect(backend.call('rangeParts',[id,0,86400000])).toEqual(native.formatRangeToParts(0,86400000))
  const resolved=backend.call('resolved',[id]) as {timeZone:string};resolved.timeZone='invalid'
  expect((backend.call('resolved',[id]) as {timeZone:string}).timeZone).toBe('UTC')
  backend.close();expect(backend.size).toBe(0)
})

test('invalid Intl requests do not allocate formatters or access arbitrary properties',()=>{
  const backend=new IntlDateTimeBackend()
  for(const args of [[['en_US'],{}],[['en'],{timeZone:'Invalid/Zone'}],[['en'],{constructor:'escape'}],
    [['en'],{hour12:1}],[['en'],{fractionalSecondDigits:NaN}],[['en'],{year:{}}]])
    expect(()=>backend.call('create',args)).toThrow()
  expect(backend.size).toBe(0)
  expect(()=>backend.call('constructor',[])).toThrow('Unknown Intl operation')
  expect(()=>backend.call('format',[1,0])).toThrow('Invalid Intl formatter')
  expect(()=>backend.call('canonical',[Array(33).fill('en')])).toThrow('limit')
  expect(()=>backend.call('create',[['en'],{timeZone:'x'.repeat(257)}])).toThrow()
})

test('formatter quotas and owner shutdown are enforced',()=>{
  const first=new IntlDateTimeBackend(1),second=new IntlDateTimeBackend(1)
  const id=first.call('create',[['en'],{timeZone:'UTC'}])
  expect(()=>second.call('format',[id,0])).toThrow('Invalid Intl formatter')
  expect(()=>first.call('create',[['en'],{}])).toThrow('limit')
  expect(()=>first.call('format',[id,null])).toThrow(RangeError)
  expect(first.call('range',[id,86400000,0])).toBe(new Intl.DateTimeFormat('en',{timeZone:'UTC'}).formatRange(86400000,0))
  first.close();expect(first.size).toBe(0)
  expect(()=>first.call('create',[['en'],{}])).toThrow('closed')
  expect(()=>first.call('format',[id,0])).toThrow('closed')
  expect(second.call('create',[['en'],{}])).toBe(1);second.close()
})
