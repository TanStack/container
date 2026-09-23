import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Duplex } from 'node:stream'
import { connect, performServerHandshake } from 'node:http2'
import { createPeer } from './http2-peer.mjs'
import { singlePeerFactory } from './http2-owned-peer.mjs'

const owned = process.argv.includes('--owned'), runtime = owned ? 'http2-runtime' : 'http2-probe'
const { default: create } = await import(`../public/${runtime}/http2.mjs`)
const factory = owned ? singlePeerFactory(create) : create
const wasmBinary = readFileSync(`public/${runtime}/http2.wasm`)
const results = []
async function run(server, fragment, streaming = false) {
  const peer = await createPeer(factory, wasmBinary, server)
  const incoming = new Map(), completed = new Set(), expected = new Map()
  const producers = new Map()
  let node, scheduled = false, ended = false, timer
  let resolve, reject
  const done = new Promise((yes, no) => { resolve = yes; reject = no })
  const fail = error => reject(error)
  const receive = events => {
    for (const event of events) {
      if (!incoming.has(event.stream)) incoming.set(event.stream, { headers: {}, chunks: [] })
      const state = incoming.get(event.stream)
      if (event.type === 1) {
        const text = Buffer.from(event.bytes).toString(), split = text.indexOf('\0')
        state.headers[text.slice(0, split)] = text.slice(split + 1)
      }
      if (event.type === 2) { state.chunks.push(Buffer.from(event.bytes)); peer.consume(event.stream, event.bytes.length) }
      if (event.type === 3 && (event.flags & 1)) {
        const body = Buffer.concat(state.chunks)
        if (server) {
          assert.equal(state.headers[':method'], 'POST')
          assert.equal(state.headers[':path'], `/stream-${event.stream}`)
          if (owned && streaming) assert.equal(state.headers['x-owned'], '42')
          assert.deepEqual(body, expected.get(event.stream))
          if (streaming) { peer.responseStart(event.stream); producers.set(event.stream, { body, offset: 0 }) }
          else peer.response(event.stream, body)
        } else {
          assert.equal(state.headers[':status'], '200')
          if (owned && streaming) assert.equal(state.headers['x-owned'], '42')
          assert.deepEqual(body, expected.get(event.stream))
          completed.add(event.stream)
          if (completed.size === 3) resolve()
        }
      }
      if (event.type === 4) assert.equal(event.flags, 0)
      if (event.type === 5) assert.equal(event.flags, 0)
    }
  }
  const pump = () => {
    if (scheduled || ended) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      if (ended) return
      try {
        for (;;) {
          for (const [stream, producer] of producers) {
            const available = 65536 - peer.queued(stream)
            if (available <= 0) continue
            const bytes = producer.body.subarray(producer.offset, producer.offset + available)
            producer.offset += peer.write(stream, bytes, producer.offset + bytes.length === producer.body.length)
            if (producer.offset === producer.body.length) producers.delete(stream)
          }
          const output = peer.send(fragment)
          receive(peer.events())
          if (!output.length) break
          wire.push(Buffer.from(output))
        }
      } catch (error) { fail(error) }
    })
  }
  const wire = new Duplex({
    read() { pump() },
    write(bytes, encoding, callback) {
      try {
        for (let offset = 0; offset < bytes.length; offset += fragment) {
          peer.feed(bytes.subarray(offset, offset + fragment))
          receive(peer.events())
        }
        callback(); pump()
      } catch (error) { callback(error) }
    },
  })
  wire.on('error', fail)
  try {
    timer = setTimeout(() => fail(new Error('HTTP/2 interoperability timed out')), 15000)
    const bodies = [Buffer.alloc(0), Buffer.from('hello HTTP/2'), Buffer.alloc(streaming ? 2 * 1024 * 1024 + 23 : 256 * 1024, 97)]
    if (server) {
      node = connect('http://localhost', { createConnection: () => wire })
      node.on('error', fail)
      node.on('connect', () => {
        for (let i = 0; i < bodies.length; i++) {
          const id = i * 2 + 1, body = bodies[i]
          expected.set(id, body)
          const stream = node.request({ ':method': 'POST', ':path': `/stream-${id}`, 'x-owned': '42' })
          const chunks = []
          stream.on('error', fail)
          stream.on('response', headers => { try { assert.equal(headers[':status'], 200); if (owned && streaming) assert.equal(headers['x-owned'], '42') } catch (error) { fail(error) } })
          stream.on('data', chunk => chunks.push(chunk))
          stream.on('end', () => {
            try {
              assert.deepEqual(Buffer.concat(chunks), body)
              completed.add(id)
              if (completed.size === 3) resolve()
            } catch (error) { fail(error) }
          })
          stream.end(body)
        }
      })
    } else {
      node = performServerHandshake(wire)
      node.on('error', fail)
      node.on('stream', (stream, headers) => {
        const chunks = []
        stream.on('error', fail)
        stream.on('data', chunk => chunks.push(chunk))
        stream.on('end', () => {
          try {
            assert.equal(headers[':method'], 'POST')
            assert.equal(headers[':path'], `/stream-${stream.id}`)
            if (owned && streaming) assert.equal(headers['x-owned'], '42')
            const body = Buffer.concat(chunks)
            assert.deepEqual(body, expected.get(stream.id))
            stream.respond({ ':status': 200, 'x-owned': '42' }); stream.end(body)
          } catch (error) { fail(error) }
        })
      })
      for (let i = 0; i < bodies.length; i++) {
        const id = streaming ? peer.requestStart(`/stream-${i * 2 + 1}`) : peer.request(bodies[i], `/stream-${i * 2 + 1}`)
        if (streaming) producers.set(id, { body: bodies[i], offset: 0 })
        expected.set(id, bodies[i])
      }
    }
    pump()
    await done
    return { role: server ? 'server' : 'client', fragment, streaming, streams: completed.size, largeBodyBytes: bodies[2].length, peakBytes: peer.peak(), passed: true }
  } finally {
    clearTimeout(timer); ended = true
    node?.destroy(); wire.destroy()
    // Let Node's destroy callbacks finish before releasing the peer.
    await new Promise(resolve => setImmediate(resolve))
    peer.close()
  }
}
for (const streaming of [false, true]) for (const server of [false, true]) for (const fragment of streaming ? [13, 16384] : [1, 13, 16384]) {
  try { results.push(await run(server, fragment, streaming)) }
  catch (error) { results.push({ role: server ? 'server' : 'client', fragment, streaming, passed: false, error: error.stack }) }
  console.log(JSON.stringify(results.at(-1)))
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
writeFileSync(`reports/http2${owned ? '-owned' : ''}-interop.json`, JSON.stringify({ node: process.version, date: new Date().toISOString(), hashes: Object.fromEntries([`src/sandbox/${runtime}.c`, 'scripts/http2-peer.mjs', 'scripts/http2-owned-peer.mjs', 'scripts/probe-http2-interop.mjs', `public/${runtime}/http2.wasm`].map(path => [path, hash(path)])), results }, null, 2) + '\n')
if (results.some(result => !result.passed)) process.exitCode = 1
