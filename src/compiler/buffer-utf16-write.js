function ucs2Write (buf, string, offset, length) {
  // Write complete UTF-16 code units directly into the destination view.
  // Surrogates are code units here, not Unicode scalar values. An odd byte
  // capacity leaves the final byte untouched, matching Node Buffer.write.
  const units = Math.min(string.length, Math.floor(Math.min(length, buf.length - offset) / 2))
  for (let i = 0; i < units; i++) {
    const code = string.charCodeAt(i)
    buf[offset + i * 2] = code & 255
    buf[offset + i * 2 + 1] = code >>> 8
  }
  return units * 2
}
