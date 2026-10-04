import type {Server as NetServer} from './guest-net.js'

export class Server extends NetServer {}
export function createServer(...args:unknown[]):Server
export function get(options:Record<string,unknown>,callback:(response:import('node:http').IncomingMessage)=>void):{on:(event:string,callback:(error:Error)=>void)=>unknown}
declare const http:{Server:typeof Server;createServer:typeof createServer;get:typeof get}
export default http
