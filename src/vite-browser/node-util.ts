import browserUtil from 'util/util.js'
import assert from 'assert'
import process from 'process/browser'
import { parseEnv } from '../sandbox/guest-util-parse-env.js'
import { stripVTControlCharacters } from '../sandbox/guest-util.js'

export const {
  callbackify, debuglog, deprecate, inherits, types,
} = browserUtil

const customPromisifySymbol=Symbol.for('nodejs.util.promisify.custom')
export const promisify=Object.assign((original:Function)=>{
  if(typeof original!=='function')return browserUtil.promisify(original)
  const custom=(original as unknown as Record<symbol,unknown>)[customPromisifySymbol]
  if(custom){
    if(typeof custom!=='function')throw TypeError('The util.promisify.custom property must be a function')
    Object.defineProperty(custom,customPromisifySymbol,{value:custom,configurable:true})
    return custom
  }
  const wrapped=browserUtil.promisify(original)
  Object.defineProperty(wrapped,customPromisifySymbol,{value:wrapped,configurable:true})
  return wrapped
},{custom:customPromisifySymbol})

export const inspect:typeof browserUtil.inspect=Object.assign(
  (value:unknown,...options:unknown[])=>value instanceof Error
    ? value.stack??String(value)
    : browserUtil.inspect(value,...options),
  browserUtil.inspect,
)

export function format(...args:unknown[]):string{
  if(args.length&&typeof args[0]!=='string')
    return args.map(value=>typeof value==='string'?value:inspect(value)).join(' ')
  return browserUtil.format(...args)
}

export { parseEnv, stripVTControlCharacters }
export const TextEncoder=globalThis.TextEncoder
export const TextDecoder=globalThis.TextDecoder

const textStyles:Record<string,readonly [number,number]>={
  reset:[0,0],bold:[1,22],dim:[2,22],italic:[3,23],underline:[4,24],
  blink:[5,25],inverse:[7,27],hidden:[8,28],strikethrough:[9,29],
  doubleunderline:[21,24],framed:[51,54],overlined:[53,55],
  black:[30,39],red:[31,39],green:[32,39],yellow:[33,39],
  blue:[34,39],magenta:[35,39],cyan:[36,39],white:[37,39],
  gray:[90,39],redBright:[91,39],greenBright:[92,39],yellowBright:[93,39],
  blueBright:[94,39],magentaBright:[95,39],cyanBright:[96,39],whiteBright:[97,39],
  bgBlack:[40,49],bgRed:[41,49],bgGreen:[42,49],bgYellow:[43,49],
  bgBlue:[44,49],bgMagenta:[45,49],bgCyan:[46,49],bgWhite:[47,49],
  bgGray:[100,49],bgRedBright:[101,49],bgGreenBright:[102,49],
  bgYellowBright:[103,49],bgBlueBright:[104,49],bgMagentaBright:[105,49],
  bgCyanBright:[106,49],bgWhiteBright:[107,49],
}

export function styleText(format:string|string[],text:string,options?:{validateStream?:boolean;stream?:{isTTY?:boolean;getColorDepth?:()=>number}}):string{
  if(typeof text!=='string')throw Object.assign(new TypeError('The "text" argument must be a string'),{code:'ERR_INVALID_ARG_TYPE'})
  if(options!==undefined&&(options===null||typeof options!=='object'||Array.isArray(options)))
    throw Object.assign(new TypeError('The "options" argument must be an object'),{code:'ERR_INVALID_ARG_TYPE'})
  const keys=Array.isArray(format)?format:[format]
  let open='',close=''
  for(const key of keys){
    const codes=textStyles[key]
    if(!codes)throw Object.assign(new TypeError(`Unknown text style: ${String(key)}`),{code:'ERR_INVALID_ARG_VALUE'})
    open+=`\u001b[${codes[0]}m`
    close=`\u001b[${codes[1]}m`+close
  }
  const stream=options?.stream??(process as typeof process & {stdout?:{isTTY?:boolean;getColorDepth?:()=>number}}).stdout
  const colorize=options?.validateStream===false||!!stream?.isTTY&&(!stream.getColorDepth||stream.getColorDepth()>2)
  return colorize?open+text+close:text
}

export function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepStrictEqual(left, right)
    return true
  } catch (error) {
    if (error instanceof assert.AssertionError) return false
    throw error
  }
}

export function formatWithOptions(options: Record<string, unknown>, ...args: unknown[]): string {
  if (args.length === 0) return ''
  const previousOptions = inspect.defaultOptions
  try {
    inspect.defaultOptions = { ...previousOptions, ...options }
    return format(...args)
  } finally {
    inspect.defaultOptions = previousOptions
  }
}

export default {
  ...browserUtil,
  promisify,
  inspect,
  format,
  formatWithOptions,
  isDeepStrictEqual,
  parseEnv,
  stripVTControlCharacters,
  styleText,
  TextEncoder,
  TextDecoder,
}
