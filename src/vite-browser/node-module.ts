import assert from 'assert'
import {isContainerModulePath} from '../native/volume-resolver'
import * as babelTraverse from '@babel/traverse'
import * as buffer from 'buffer'
import crypto from './node-crypto'
import events from './node-events'
import childProcess from '../native/child-process'
import http from '../sandbox/guest-http.js'
import net from '../sandbox/guest-net.js'
import https from 'https-browserify'
import os from 'os-browserify/browser'
import picomatch from 'picomatch'
import postcss from 'postcss'
import stream from 'stream-browserify'
import util from './node-util'
import consoleModule from './node-console'
import process from 'process/browser'
import querystring from 'querystring-es3'
import tty from 'tty-browserify'
import zlib from './node-zlib'
import * as fs from './node-fs'
import * as fsPromises from './node-fs-promises'
import path from './node-path'
import stubs from './node-stubs'
import urlModule from './node-url'
import * as dns from './node-dns'
import tls from './node-tls'
import * as timersPromises from './node-timers-promises'
import * as streamPromises from './node-stream-promises'
import * as streamWeb from './node-stream-web'
import * as readline from './node-readline'
import * as v8 from './node-v8'
import vm from './node-vm'
import {NativeAsyncLocalStorage,NativeAsyncResource,executionAsyncId} from '../native/async-context'
import {BrowserCommonJS} from '../native/commonjs'
import * as workerThreads from '../native/worker-threads'
import * as wasi from './node-wasi'

export const builtinModules = [
  'console',
  'assert', 'async_hooks', 'buffer', 'crypto', 'events', 'fs', 'fs/promises', 'http', 'https', 'module', 'os',
  'path', 'path/posix', 'process', 'querystring', 'stream', 'string_decoder', 'tty', 'url', 'util',
  'vm', 'zlib',
  'wasi',
  'child_process','dns','http2','net','perf_hooks','readline','stream/promises',
  'stream/web','timers','timers/promises','tls','v8','worker_threads',
]

// Node's loader customization hooks do not exist in a browser worker.
// Vite checks for these methods before selecting a loader path.
export const Module = {}

export function isBuiltin(specifier: string): boolean {
  return builtinModules.includes(specifier.replace(/^node:/, ''))
}

export function createRequire(url: string | URL) {
  const filename=String(url).startsWith('file:')?decodeURIComponent(new URL(String(url)).pathname):String(url)
  const commonJS=isContainerModulePath(filename)?new BrowserCommonJS(undefined,undefined,false):undefined
  const babelTraverseDefault=typeof babelTraverse.default==='function'
    ?babelTraverse.default
    :(babelTraverse.default as unknown as {default:unknown}).default
  const requiredModules: Record<string, unknown> = {
    console:consoleModule,
    '@babel/traverse': {...babelTraverse,default:babelTraverseDefault},
    assert,
    async_hooks:{AsyncLocalStorage:NativeAsyncLocalStorage,AsyncResource:NativeAsyncResource,executionAsyncId},
    buffer,
    child_process: childProcess,
    crypto,
    dns,
    events,
    fs,
    'fs/promises': fsPromises,
    http,
    http2: stubs,
    https,
    net,
    os,
    path,
    'path/posix':path.posix,
    perf_hooks:{performance:globalThis.performance},
    picomatch,
    postcss,
    process,
    querystring,
    readline,
    stream,
    'stream/promises':streamPromises,
    'stream/web':streamWeb,
    sugarss: {},
    tls,
    timers:{setTimeout:globalThis.setTimeout,setInterval:globalThis.setInterval,clearTimeout:globalThis.clearTimeout,clearInterval:globalThis.clearInterval,
      setImmediate:globalThis.setImmediate,clearImmediate:globalThis.clearImmediate},
    'timers/promises':timersPromises,
    tty,
    url: urlModule,
    util,
    v8,
    vm,
    worker_threads:workerThreads,
    wasi,
    zlib,
  }
  const require = (specifier: string): unknown => {
    const normalized = specifier.replace(/^node:/, '')
    if (normalized === 'module') return { Module,builtinModules, createRequire, isBuiltin }
    const module = requiredModules[normalized]
    if (module) return module
    if (specifier === 'fsevents') return null
    if(commonJS)return commonJS.load(commonJS.resolve(specifier,filename))
    throw new Error(`Synchronous require('${specifier}') is unavailable from ${url}`)
  }
  require.resolve = (specifier: string) => {
    return (commonJS??new BrowserCommonJS()).resolve(specifier,filename)
  }
  require.cache = {}
  return require
}

export const syncBuiltinESMExports = () => {}
export const findSourceMap = () => undefined
export default { Module,builtinModules, createRequire, findSourceMap, isBuiltin, syncBuiltinESMExports }
