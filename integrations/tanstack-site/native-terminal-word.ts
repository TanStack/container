export function deleteTerminalWord(
  input: string,
  cursor: number,
  kind: 'whitespace' | 'word',
) {
  const prefix = input.slice(0, cursor)
  const match = kind === 'whitespace'
    ? /\S+\s*$/u.exec(prefix)
    : /[\p{L}\p{N}_]+[^\p{L}\p{N}_]*$/u.exec(prefix)
  const start = match?.index ?? 0
  return { input: input.slice(0, start) + input.slice(cursor), cursor: start }
}
