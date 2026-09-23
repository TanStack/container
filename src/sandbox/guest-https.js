import {Server as TLSServer,connect} from 'node:tls'
import {Server as HTTPServer,Agent as HTTPAgent,ClientRequest} from 'node:http'

export class Server extends TLSServer {
  constructor(options={},listener){
    if(typeof options==='function'){listener=options;options={}}
    super(options)
    HTTPServer.prototype._initializeHTTP.call(this,options,listener)
    this.on('secureConnection',socket=>HTTPServer.prototype._connection.call(this,socket))
  }
  setTimeout(...args){return HTTPServer.prototype.setTimeout.apply(this,args)}
  close(callback){super.close(callback);this.closeIdleConnections();return this}
  closeIdleConnections(){return HTTPServer.prototype.closeIdleConnections.call(this)}
  closeAllConnections(){return HTTPServer.prototype.closeAllConnections.call(this)}
}
export class Agent extends HTTPAgent {
  constructor(options={}){super(options);this.defaultPort=443;this.protocol='https:'}
  createConnection(options,callback){
    const {path,...settings}=options
    return connect({...settings,servername:settings.servername??settings.host},callback)
  }
  getName(options){return (options.host??'localhost')+':'+(options.port??443)+':'}
}
export const globalAgent=new Agent()
export const createServer=(...args)=>new Server(...args)
export function request(input,options,callback){
  if(typeof options==='function'){callback=options;options=undefined}
  return new ClientRequest(input,{...options,_defaultAgent:globalAgent},callback)
}
export function get(...args){const req=request(...args);req.end();return req}
export default {Server,Agent,globalAgent,createServer,request,get}
