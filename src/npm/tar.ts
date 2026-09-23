const blockSize = 512
const decoder = new TextDecoder()

export interface TarFile {
  path: string
  contents: Uint8Array
  mode: number
}

function readString(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length)
  const end = field.indexOf(0)
  return decoder.decode(end === -1 ? field : field.subarray(0, end)).trim()
}

function readOctal(bytes: Uint8Array, start: number, length: number): number {
  const value = readString(bytes, start, length).replace(/\0/g, '').trim()
  if(value&&!/^[0-7]+$/.test(value))throw Error('Invalid tar numeric field')
  const number=value ? Number.parseInt(value, 8) : 0
  if(!Number.isSafeInteger(number))throw Error('Tar numeric field exceeds safe range')
  return number
}

function parsePaxPath(contents: Uint8Array): string | undefined {
  let offset = 0
  let path: string | undefined
  while (offset < contents.length) {
    const space = contents.indexOf(32, offset)
    if (space === -1) throw Error('Invalid PAX record')
    const field=decoder.decode(contents.subarray(offset,space))
    const length = Number(field)
    if (!/^[0-9]+$/.test(field)||!Number.isSafeInteger(length)||length<=space-offset+1||offset+length>contents.length||contents[offset+length-1]!==10)throw Error('Invalid PAX record length')
    const record = decoder.decode(contents.subarray(space + 1, offset + length - 1))
    const equals = record.indexOf('=')
    if (equals !== -1 && record.slice(0, equals) === 'path') {
      path = record.slice(equals + 1)
    }
    offset += length
  }
  return path
}

function safePackagePath(path: string): string | undefined {
  const normalized = path.replace(/^\.\//, '')
  if(normalized.startsWith('/')||normalized.includes('\\')||normalized.includes('\0')||normalized.split('/').includes('..'))throw Error('Unsafe tar entry path')
  // npm strips one archive directory. DefinitelyTyped archives use the package
  // name here, not the conventional "package" directory.
  const slash=normalized.indexOf('/')
  return slash<0?undefined:normalized.slice(slash+1)||undefined
}

export function extractTarFiles(archive: Uint8Array): TarFile[] {
  const files: TarFile[] = []
  let offset = 0
  let nextPath: string | undefined

  while (offset + blockSize <= archive.length) {
    const header = archive.subarray(offset, offset + blockSize)
    if (header.every((byte) => byte === 0)) break
    const checksum=header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0)
    if(readOctal(header,148,8)!==checksum)throw Error('Invalid tar header checksum')

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const headerPath = prefix ? `${prefix}/${name}` : name
    const size = readOctal(header, 124, 12)
    const mode = readOctal(header, 100, 8)&0o7777
    const type = String.fromCharCode(header[156] || 48)
    const contentsStart = offset + blockSize
    const contentsEnd = contentsStart + size
    if (contentsEnd > archive.length) throw new Error(`Truncated tar entry '${headerPath}'`)
    const contents = archive.slice(contentsStart, contentsEnd)

    if (type === 'x') {
      nextPath = parsePaxPath(contents)
    } else if (type === 'L') {
      nextPath = readString(contents, 0, contents.length)
    } else {
      const path = safePackagePath(nextPath ?? headerPath)
      nextPath = undefined
      if (path && (type === '0' || type === '\0')) files.push({ path, contents, mode })
      else if(type!=='5'&&type!=='g')throw Error('Unsupported tar entry type: '+type)
    }

    offset = contentsStart + Math.ceil(size / blockSize) * blockSize
  }

  return files
}
