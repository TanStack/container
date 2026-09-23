import url from 'url'

export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams
export const domainToASCII = url.domainToASCII ?? ((value: string) => value)
export const domainToUnicode = url.domainToUnicode ?? ((value: string) => value)
export const format = url.format
export const parse = url.parse
export const resolve = url.resolve
export const resolveObject = url.resolveObject
export const urlToHttpOptions = url.urlToHttpOptions

export function fileURLToPath(value: string | URL): string {
  const parsed = value instanceof URL ? value : new URL(value)
  return decodeURIComponent(parsed.pathname)
}

export function pathToFileURL(path: string): URL {
  const pathname = path.startsWith('/') ? path : `/${path}`
  return new URL(`file://${pathname.split('/').map(encodeURIComponent).join('/')}`)
}

export default { ...url, URL, URLSearchParams, fileURLToPath, pathToFileURL }
