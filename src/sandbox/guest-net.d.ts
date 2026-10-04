import type {EventEmitter} from 'events'

export class Server extends EventEmitter {
  listen(...args:unknown[]):this
  close(callback?:()=>void):this
  address():{address:string;family:string;port:number}|null
}
export function createServer(...args:unknown[]):Server
export function isIP(value:unknown):0|4|6
declare const net:{Server:typeof Server;createServer:typeof createServer;isIP:typeof isIP}
export default net
