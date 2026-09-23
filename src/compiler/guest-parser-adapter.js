// Capture callback ownership at invocation, before crossing the async host bridge.
export function createGuestParserAdapter(host,callbackScope){
  const decode=JSON.parse
  return function parse(filename,source,options){
    const origin=callbackScope.getStore()
    return host(filename,source,options,origin?.operation,origin?.callback).then(decode)
  }
}
