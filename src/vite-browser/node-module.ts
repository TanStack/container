import assert from 'assert'
import * as babelTraverse from '@babel/traverse'
import * as buffer from 'buffer'
import crypto from 'crypto-browserify'
import events from 'events'
import http from 'stream-http'
import https from 'https-browserify'
import os from 'os-browserify/browser'
import picomatch from 'picomatch'
import postcss from 'postcss'
import stream from 'stream-browserify'
import util from 'util'
import zlib from 'browserify-zlib'
import fs from './node-fs'
import path from './node-path'
import stubs from './node-stubs'
import urlModule from './node-url'

export const builtinModules = [
  'assert', 'buffer', 'crypto', 'events', 'fs', 'http', 'https', 'module', 'os',
  'path', 'process', 'querystring', 'stream', 'string_decoder', 'tty', 'url', 'util',
  'vm', 'zlib',
]

export function isBuiltin(specifier: string): boolean {
  return builtinModules.includes(specifier.replace(/^node:/, ''))
}

export function createRequire(url: string | URL) {
  const requiredModules: Record<string, unknown> = {
    '@babel/traverse': babelTraverse,
    assert,
    buffer,
    child_process: stubs,
    crypto,
    events,
    fs,
    http,
    http2: stubs,
    https,
    net: stubs,
    os,
    path,
    picomatch,
    postcss,
    stream,
    sugarss: {},
    tls: stubs,
    url: urlModule,
    util,
    zlib,
  }
  const require = (specifier: string): unknown => {
    const normalized = specifier.replace(/^node:/, '')
    if (normalized === 'module') return { builtinModules, createRequire, isBuiltin }
    const module = requiredModules[normalized]
    if (module) return module
    if (specifier === 'fsevents') return null
    throw new Error(`Synchronous require('${specifier}') is unavailable from ${url}`)
  }
  require.resolve = (specifier: string) => specifier
  require.cache = {}
  return require
}

export const syncBuiltinESMExports = () => {}
export const findSourceMap = () => undefined
export default { builtinModules, createRequire, findSourceMap, isBuiltin, syncBuiltinESMExports }
