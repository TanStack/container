export function normalizePath(input: string): string {
  const parts: string[] = []
  const absolute = input.startsWith('/') ? input : `/${input}`

  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }

  return `/${parts.join('/')}`
}

export function dirname(input: string): string {
  const path = normalizePath(input)
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'))
}
