declare module 'sha.js' {
  interface Hash {
    update(data: Uint8Array): Hash
    digest(): Uint8Array
  }

  export default function createHash(algorithm: string): Hash
}
