export function ipcMessage(value:unknown,serialization:'json'|'advanced'='json'){
  if(value===null||!['string','number','boolean','object'].includes(typeof value))
    throw new TypeError('IPC messages must be strings, numbers, booleans or objects')
  return serialization==='json'?JSON.parse(JSON.stringify(value)):value
}
