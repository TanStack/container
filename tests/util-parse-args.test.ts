import {describe,it,expect} from 'vitest'
import {parseArgs as nativeParseArgs} from 'node:util'
import {parseArgs} from '../src/sandbox/guest-util-parse-args.js'

const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value))
const cases=[
  {args:['--port','3000','--watch'],options:{port:{type:'string' as const},watch:{type:'boolean' as const}}},
  {args:['-abc'],options:{alpha:{type:'boolean' as const,short:'a'},beta:{type:'boolean' as const,short:'b'},color:{type:'boolean' as const,short:'c'}}},
  {args:['-p4173'],options:{port:{type:'string' as const,short:'p'}}},
  {args:['--no-color'],allowNegative:true,options:{color:{type:'boolean' as const}}},
  {args:['--tag=one','--tag','two'],options:{tag:{type:'string' as const,multiple:true,default:['default']}}},
  {args:['src/index.ts','--','--literal'],allowPositionals:true,tokens:true,options:{}},
  {args:['--mode=production'],tokens:true,options:{mode:{type:'string' as const}}},
]

describe('guest util.parseArgs',()=>{
  it.each(cases)('matches Node for ordinary CLI input %#',input=>{
    expect(normalize(parseArgs(input as never))).toEqual(normalize(nativeParseArgs(input as never)))
    expect(Object.getPrototypeOf(parseArgs(input as never).values)).toBe(null)
  })

  it.each([
    {args:['--missing'],options:{}},
    {args:['unexpected'],options:{}},
    {args:['--port'],options:{port:{type:'string' as const}}},
    {args:['--watch=yes'],options:{watch:{type:'boolean' as const}}},
  ])('matches Node error codes for invalid input %#',input=>{
    let nativeCode,guestCode
    try{nativeParseArgs(input as never)}catch(error){nativeCode=(error as NodeJS.ErrnoException).code}
    try{parseArgs(input as never)}catch(error){guestCode=(error as NodeJS.ErrnoException).code}
    expect(guestCode).toBe(nativeCode)
  })

  it('does not mutate options, defaults, or argument arrays',()=>{
    const input={args:['--tag','one'],options:{tag:{type:'string' as const,multiple:true,default:['default']}}}
    parseArgs(input)
    expect(input).toEqual({args:['--tag','one'],options:{tag:{type:'string',multiple:true,default:['default']}}})
  })
})
