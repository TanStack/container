export const constants:Record<string,number|string>={}
export class Http2ServerResponse {}
export function createSecureServer():never{
  throw Error('HTTP/2 TLS servers are unavailable in this browser worker')
}
export default {constants,Http2ServerResponse,createSecureServer}
