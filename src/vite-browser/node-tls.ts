function unsupported():never{
  throw Object.assign(new Error('TLS sockets are not supported by the browser runtime'),{code:'ERR_UNSUPPORTED_OPERATION'})
}

// Importing the Node module is allowed. No operation pretends to establish TLS.
export class TLSSocket{constructor(..._args:unknown[]){unsupported()}}
export class Server{constructor(..._args:unknown[]){unsupported()}}
export const connect=unsupported
export const createServer=unsupported
export const createSecureContext=unsupported
export const getCiphers=unsupported
export const rootCertificates:string[]=[]
export default {TLSSocket,Server,connect,createServer,createSecureContext,getCiphers,rootCertificates}
