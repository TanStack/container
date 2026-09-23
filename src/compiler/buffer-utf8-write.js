// Count without allocating, or encode directly into the destination buffer.
function utf8Encode (string, buffer, offset = 0, limit = Infinity) {
  const host = globalThis.__webContainerHost
  if (!buffer && typeof host?.utf8ByteLength === 'function') return host.utf8ByteLength(string)
  if (buffer && typeof host?.writeUTF8 === 'function') {
    return host.writeUTF8(string, buffer, offset, Math.min(limit, buffer.length - offset))
  }
  let written = 0
  for (let i = 0; i < string.length; i++) {
    let point = string.charCodeAt(i)
    if (point >= 0xD800 && point <= 0xDBFF) {
      const next = string.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        point = 0x10000 + ((point - 0xD800) << 10) + next - 0xDC00
        i++
      } else point = 0xFFFD
    } else if (point >= 0xDC00 && point <= 0xDFFF) point = 0xFFFD
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
    if (written + size > limit) break
    if (buffer) {
      let at = offset + written
      if (size === 1) buffer[at] = point
      else {
        if (size === 4) buffer[at++] = 0xF0 | (point >>> 18)
        if (size >= 3) buffer[at++] = (size === 3 ? 0xE0 : 0x80) | ((point >>> 12) & 0x3F)
        buffer[at++] = (size === 2 ? 0xC0 : 0x80) | ((point >>> 6) & 0x3F)
        buffer[at] = 0x80 | (point & 0x3F)
      }
    }
    written += size
  }
  return written
}

function utf8Write (buf, string, offset, length) {
  return utf8Encode(string, buf, offset, Math.min(length, buf.length - offset))
}
