export function stageFetchRequest(source){
  const marker='\t\t// Normalize method: https://fetch.spec.whatwg.org/#methods'
  if(source.split(marker).length!==2)throw Error('Unexpected guest Request constructor source')
  return source.replace(marker,`\t\t// Reject credentials before URL formatting can discard them.
\t\tif (parsedURL.username || parsedURL.password) {
\t\t\tthrow new TypeError('Request URLs cannot contain credentials');
\t\t}

${marker}`)
}
