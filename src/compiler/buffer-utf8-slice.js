// Non-streaming UTF-8 decoding with one replacement per invalid subsequence.
// Keep BOMs, as Buffer.toString does. Used by both guest Buffer builds.
function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  const result = []
  let needed = 0, seen = 0, point = 0, lower = 0x80, upper = 0xbf
  for (let i = start; i < end; i++) {
    const byte = buf[i]
    if (needed === 0) {
      if (byte <= 0x7f) result.push(byte)
      else if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; point = byte & 0x1f }
      else if (byte >= 0xe0 && byte <= 0xef) {
        needed = 2; point = byte & 0x0f
        if (byte === 0xe0) lower = 0xa0
        if (byte === 0xed) upper = 0x9f
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        needed = 3; point = byte & 0x07
        if (byte === 0xf0) lower = 0x90
        if (byte === 0xf4) upper = 0x8f
      } else result.push(0xfffd)
    } else if (byte < lower || byte > upper) {
      result.push(0xfffd)
      needed = seen = point = 0; lower = 0x80; upper = 0xbf
      i-- // Decode the offending byte again as a possible new sequence.
    } else {
      lower = 0x80; upper = 0xbf
      point = (point << 6) | (byte & 0x3f)
      if (++seen === needed) {
        if (point > 0xffff) {
          point -= 0x10000
          result.push((point >>> 10) | 0xd800, (point & 0x3ff) | 0xdc00)
        } else result.push(point)
        needed = seen = point = 0
      }
    }
  }
  if (needed !== 0) result.push(0xfffd)
  return decodeCodePointsArray(result)
}
