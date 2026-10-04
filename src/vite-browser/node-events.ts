import EventEmitter from 'events/events.js'
import {NativeAsyncResource} from '../native/async-context'

export {EventEmitter}
export const once=EventEmitter.once

export class EventEmitterAsyncResource extends EventEmitter{
  readonly asyncResource:NativeAsyncResource & {eventEmitter:EventEmitterAsyncResource}
  constructor(options:{name?:string;triggerAsyncId?:number;requireManualDestroy?:boolean;captureRejections?:boolean}={}){
    super(options)
    this.asyncResource=Object.assign(new NativeAsyncResource(options.name??new.target.name,options),{eventEmitter:this})
  }
  emit(event:string|symbol,...args:any[]):boolean{
    return this.asyncResource.runInAsyncScope(super.emit,this,event,...args)
  }
  get asyncId(){return this.asyncResource.asyncId()}
  get triggerAsyncId(){return this.asyncResource.triggerAsyncId()}
  emitDestroy(){this.asyncResource.emitDestroy()}
}

Object.assign(EventEmitter,{EventEmitterAsyncResource})
export default EventEmitter
