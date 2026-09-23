import crypto from 'crypto-browserify'

export const createHash = crypto.createHash.bind(crypto)
export const createHmac = crypto.createHmac.bind(crypto)
export const randomBytes = crypto.randomBytes.bind(crypto)

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(array) as T
  }
  const bytes = randomBytes(array.byteLength)
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes)
  return array
}

export const randomUUID = typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID.bind(globalThis.crypto)
  : () => {
      const bytes = getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
export const subtle = globalThis.crypto?.subtle

export default { ...crypto, getRandomValues, randomUUID, subtle }
