declare module 'events/events.js' {
  import type {EventEmitter as NodeEventEmitter} from 'node:events'
  const EventEmitter:{
    new(options?:{captureRejections?:boolean}):NodeEventEmitter
    prototype:NodeEventEmitter
    once:typeof import('node:events').once
  }
  export default EventEmitter
}
