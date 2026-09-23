import { createPeer } from '../scripts/http2-peer.mjs'

const assert = (condition, message) => { if (!condition) throw new Error(message) }
export async function http2Workflow(factory, binary, fragment) {
  const client = await createPeer(factory, binary, false)
  const server = await createPeer(factory, binary, true)
  const requests = new Map(), responses = new Map(), expected = new Map()
  const closed = []
  const collect = (peer, map, respond) => {
    for (const event of peer.events()) {
      if (!map.has(event.stream)) map.set(event.stream, { headers: {}, bytes: [] })
      const state = map.get(event.stream)
      if (event.type === 1) {
        const text = new TextDecoder().decode(event.bytes), index = text.indexOf('\0')
        state.headers[text.slice(0, index)] = text.slice(index + 1)
      }
      if (event.type === 2) { state.bytes.push(event.bytes); peer.consume(event.stream, event.bytes.length) }
      if (event.type === 3 && (event.flags & 1)) {
        const bytes = new Uint8Array(state.bytes.reduce((total, chunk) => total + chunk.length, 0))
        let offset = 0
        for (const chunk of state.bytes) { bytes.set(chunk, offset); offset += chunk.length }
        const original = expected.get(event.stream)
        assert(original && bytes.length === original.length && bytes.every((value, i) => value === original[i]), 'Body mismatch')
        assert(state.headers[respond ? ':method' : ':status'] === (respond ? 'POST' : '200'), 'Header mismatch')
        state.complete = true
        if (respond) peer.response(event.stream, bytes)
      }
      if (event.type === 4) closed.push(event.flags)
    }
  }
  const transfer = (from, to, map, respond) => {
    const bytes = from.send(fragment)
    if (bytes.length) { to.feed(bytes); collect(to, map, respond) }
    return bytes.length
  }
  const pump = () => {
    for (let iteration = 0; iteration < 2000000; iteration++) {
      const a = transfer(client, server, requests, true)
      const b = transfer(server, client, responses, false)
      collect(client, responses, false); collect(server, requests, true)
      if (!a && !b) return
    }
    throw new Error('Transport failed to become idle')
  }
  try {
    for (const length of [0, 23, 262144]) {
      const bytes = Uint8Array.from({ length }, (_, i) => i % 251)
      expected.set(client.request(bytes), bytes)
    }
    pump()
    assert([...responses.values()].filter(state => state.complete).length === 3, 'Missing responses')
    assert(closed.length === 6 && closed.every(code => code === 0), 'Unexpected stream close')
    const cancelled = client.request(new Uint8Array(262144), '/cancel')
    // Send only through the first request header, before its body can finish.
    while (!requests.has(cancelled)) {
      assert(transfer(client, server, requests, true) > 0, 'Missing cancellation stream')
    }
    client.reset(cancelled)
    pump()
    assert(closed.filter(code => code === 8).length === 2, 'Reset not observed by both peers')
    return { streams: 3, bytes: 262144, resetPeers: 2, peak: [client.peak(), server.peak()] }
  } finally { client.close(); server.close() }
}

export async function http2Limits(factory, binary) {
  let failures = 0, successes = 0
  for (const budget of [65536, 98304, 131072, 196608, 262144, 524288, 1048576]) {
    let peer
    try {
      peer = await createPeer(factory, binary, false, budget)
      peer.request(new Uint8Array(262144))
      successes++
    } catch { failures++ }
    finally { peer?.close() }
  }
  assert(failures > 0 && successes > 0, 'Limits did not exercise both outcomes')
  const peer = await createPeer(factory, binary, true)
  let malformed = false
  try { peer.feed(new TextEncoder().encode('not an HTTP/2 connection preface')) }
  catch { malformed = true }
  finally { peer.close() }
  assert(malformed, 'Invalid preface accepted')
  const recovered = await createPeer(factory, binary, false)
  recovered.request(new Uint8Array([42])); recovered.close()
  return { failures, successes, malformed, recovered: true }
}

export async function http2Streaming(factory, binary, fragment) {
  const client = await createPeer(factory, binary, false), server = await createPeer(factory, binary, true)
  const request = { received: 0, credit: 0, consume: false, ended: false }
  const response = { received: 0, credit: 0, consume: false, ended: false }
  const id = client.requestStart('/streaming')
  const total = 3 * 1024 * 1024 + 17
  const collect = (peer, state) => {
    for (const event of peer.events()) {
      if (event.type === 2) {
        assert(event.bytes.every((value, i) => value === (state.received + i) % 251), 'Streaming bytes changed')
        state.received += event.bytes.length
        if (state.consume) peer.consume(event.stream, event.bytes.length)
        else state.credit += event.bytes.length
      }
      if (event.type === 3 && (event.flags & 1)) state.ended = true
      if (event.type === 4 || event.type === 5) assert(event.flags === 0, 'Streaming protocol failure')
    }
  }
  const pump = () => {
    for (let iteration = 0; iteration < 2000000; iteration++) {
      const a = client.send(fragment)
      if (a.length) server.feed(a)
      collect(server, request)
      const b = server.send(fragment)
      if (b.length) client.feed(b)
      collect(client, response)
      if (!a.length && !b.length) return
    }
    throw new Error('Streaming transport did not settle')
  }
  const phase = (sender, receiver, state) => {
    let written = 0
    const write = length => {
      const bytes = Uint8Array.from({ length }, (_, i) => (written + i) % 251)
      const accepted = sender.write(id, bytes)
      written += accepted
      return accepted
    }
    assert(write(65536) === 65536 && sender.queued(id) === 65536, 'Queue did not fill')
    assert(sender.write(id, new Uint8Array([1]), true) === 0, 'Full queue accepted bytes')
    pump()
    assert(state.received === 65535 && !state.ended, 'Paused reader did not stop at its window')
    write(65536)
    const paused = state.received
    pump(); pump()
    assert(state.received === paused && sender.queued(id) === 65536, 'Paused reader allowed sender to advance')
    let denied = false
    try { receiver.consume(id, state.credit + 1) } catch { denied = true }
    assert(denied, 'Over-acknowledgment was accepted')
    receiver.consume(id, state.credit); state.credit = 0; state.consume = true
    pump()
    while (written < total) {
      const accepted = write(Math.min(65536, total - written))
      pump()
      assert(accepted > 0, 'Resumed sender stalled')
    }
    sender.write(id, new Uint8Array(), true)
    pump()
    assert(state.received === total && state.ended, 'Missing streaming end or bytes')
    return paused
  }
  try {
    pump()
    assert(!request.ended, 'Deferred producer ended prematurely')
    const requestPaused = phase(client, server, request)
    server.responseStart(id)
    pump()
    assert(!response.ended, 'Deferred response ended prematurely')
    const responsePaused = phase(server, client, response)
    return { bytesEachDirection: total, requestPaused, responsePaused, queueLimit: 65536, peak: [client.peak(), server.peak()] }
  } finally { client.close(); server.close() }
}
