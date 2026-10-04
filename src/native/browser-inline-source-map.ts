/** Read Vite's final inline map, which already includes the evaluator offset. */
export function browserInlineSourceMap(code:string):unknown|null{
  const pattern=/\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,\s]+)?;base64,([A-Za-z0-9+/=]+)\s*$/gm
  let match:RegExpExecArray|null,last:string|undefined
  while((match=pattern.exec(code)))last=match[1]
  if(!last)return null
  const bytes=Uint8Array.from(atob(last),character=>character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}
