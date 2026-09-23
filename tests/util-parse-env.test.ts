import {describe,it,expect} from 'vitest'
import {parseEnv as nativeParseEnv} from 'node:util'
import {parseEnv} from '../src/sandbox/guest-util-parse-env.js'

const cases=[
  '', ' \t\n', 'A=one\nB = two\r\nEMPTY=',
  'A=one # tail\nB="two # hash" # tail\n# full\nC=three#tail',
  "A='hello world'\nB=\"hello world\"\nC=`hello world`",
  "A=\"first\nsecond\"\nB='first\nsecond'\nC=`first\nsecond`",
  'A="one\\ntwo\\rthree\\tfour\\"five"\nB=\'one\\ntwo\'\nC=`one\\ntwo`',
  'A=1\nB=2\nA=3',
  'export A=1\n export B=2\nexportC=3\nexport\tD=4',
  'export  A=1\nexport =x',
  'export EMPTY=', 'export EMPTY= \n', 'export EMPTY=\nNEXT=value',
  'export EMPTY=#comment', 'export EMPTY=""', 'export A= \nB=x',
  'bad line\n1A=value\nA-B=x\nA.B=y\n=empty\n_ABC=z\na b=one',
  'A="hello\nB=two', "A='hello\nB=two",
  'A="quoted"suffix\nB=last', 'A="one" B=two\nC=three',
  ' A =  a b  \nB=\t x \t', 'A=one=two',
  'A=\nB=x', 'A= \nB=x', 'A=\t\nB=x', 'A= \n\nB=x',
  'A= #comment\nB=x', 'A= \n#comment\nB=x',
  'A="x\r\ny"\nB="x\ry"', 'A=abc\0def\nB=x',
  '\uFEFFA=first\nB=second', 'A=\u00a0x\u00a0', 'A=\vword\f',
  'A#x=y', 'A=foo"bar',
]

describe('guest util.parseEnv',()=>{
  it.each(cases)('matches Node for dotenv input %#',input=>{
    const actual=parseEnv(input)
    expect(actual).toEqual(nativeParseEnv(input))
    expect(Object.getPrototypeOf(actual)).toBe(Object.prototype)
  })
  it.each([undefined,null,42,true,{},[],Buffer.from('A=1'),new String('A=1')])('matches invalid argument type %#',input=>{
    const capture=(fn:()=>unknown)=>{try{fn();return undefined}catch(error){return {name:(error as Error).name,code:(error as NodeJS.ErrnoException).code}}}
    expect(capture(()=>parseEnv(input as string))).toEqual(capture(()=>nativeParseEnv(input as string)))
  })
  it('does not interpolate values or change process.env',()=>{
    const before={...process.env}
    expect(parseEnv('A=$HOME\nB=${A}')).toEqual({A:'$HOME',B:'${A}'})
    expect(process.env).toEqual(before)
  })
})
