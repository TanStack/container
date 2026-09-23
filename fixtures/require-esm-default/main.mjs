import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const required=require('./value.mjs')
const imported=await import('./value.mjs')
required.bump()
imported.bump()
console.log(JSON.stringify({
  cached:require('./value.mjs')===required,
  same:required===imported,
  value:required.default,
  imported:imported.default,
  marker:required.__esModule,
  descriptor:Object.getOwnPropertyDescriptor(required,'__esModule'),
  extensible:Object.isExtensible(required),
  tag:Object.prototype.toString.call(required),
  explicit:require('./marker.mjs').__esModule,
  custom:require('./custom.mjs'),
}))
