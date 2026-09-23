// Trusted compatibility libraries, bundled at build time and executed only in
// the guest. Application packages are never evaluated by this build.
import util from 'util/'
import assert from 'assert/'
import comparisons from 'assert/build/internal/util/comparisons.js'
import * as buffer from 'buffer'
import createHash from 'create-hash'
import createHmac from 'create-hmac'
import querystring from './vendor/node24/querystring.cjs'
import path from './vendor/node24/path.cjs'
import stream from './shared-stream.cjs'
import stringDecoder from 'string_decoder/'
import {installWebStreamAdapters} from './stream-adapters.js'
import {stripVTControlCharacters} from '../sandbox/guest-util.js'
installWebStreamAdapters(stream)
util.stripVTControlCharacters=stripVTControlCharacters

const custom=Symbol.for('nodejs.util.promisify.custom')
function promisify(original){
  if(typeof original!=='function')throw Object.assign(new TypeError('Expected a function'),{code:'ERR_INVALID_ARG_TYPE'})
  if(original[custom]!==undefined){
    const result=original[custom]
    if(typeof result!=='function')throw Object.assign(new TypeError('Expected a custom promisify function'),{code:'ERR_INVALID_ARG_TYPE'})
    Object.defineProperty(result,custom,{value:result,configurable:true})
    return result
  }
  function result(...args){return new Promise((resolve,reject)=>original.call(this,...args,(error,value)=>error?reject(error):resolve(value)))}
  Object.setPrototypeOf(result,Object.getPrototypeOf(original))
  Object.defineProperties(result,Object.getOwnPropertyDescriptors(original))
  Object.defineProperty(result,custom,{value:result,configurable:true})
  return result
}
Object.defineProperty(promisify,'custom',{value:custom,configurable:true})
util.promisify=promisify
util.isDeepStrictEqual=comparisons.isDeepStrictEqual
export {util,assert,buffer,createHash,createHmac,querystring,path,stream,stringDecoder}
