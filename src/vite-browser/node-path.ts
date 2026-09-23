import path from 'path-browserify'

export const basename = path.basename
export const delimiter = ':'
export const dirname = path.dirname
export const extname = path.extname
export const format = path.format
export const isAbsolute = path.isAbsolute
export const join = path.join
export const normalize = path.normalize
export const parse = path.parse
export const relative = path.relative
export const resolve = path.resolve
export const sep = '/'
export const posix = path.posix ?? path
export const win32 = { ...path, delimiter: ';', sep: '\\' }

export default { ...path, delimiter, posix, sep, win32 }
