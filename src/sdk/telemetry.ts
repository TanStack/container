export type SandboxTelemetryEvent=
  | {sequence:number;type:'process.start';command:string;args:string[];cwd?:string}
  | {sequence:number;type:'process.exit';status:number|null;signal:string|null;truncated:boolean}
  | {sequence:number;type:'file.write';path:string;bytes:number}
  | {sequence:number;type:'file.mkdir';path:string}
  | {sequence:number;type:'file.remove';path:string}
  | {sequence:number;type:'file.move';from:string;to:string}
  | {sequence:number;type:'install.complete';installed:number;skipped:number;ignoredScripts:number}
  | {sequence:number;type:'snapshot.capture';files:number;directories:number}
  | {sequence:number;type:'snapshot.restore';files:number;directories:number}
  | {sequence:number;type:'resources.sample';processes:{active:number;retained:number};network:{handles:number;listeners:number};datagrams:{handles:number;bound:number};fileSessions:number;executing:boolean;installing:boolean}
  | {sequence:number;type:'session.close'}

export interface SandboxTelemetryOptions {capacity?:number}

type EventInput=SandboxTelemetryEvent extends infer Event
  ? Event extends SandboxTelemetryEvent ? Omit<Event,'sequence'> : never
  : never

/**
 * A bounded, in-memory lifecycle log for sandbox hosts.
 *
 * This is application telemetry, not a Node trace-events implementation. It
 * has no clock or external exporter, so equal operations produce equal events.
 */
export class SandboxTelemetry {
  readonly capacity:number
  #sequence=0
  #dropped=0
  #events:SandboxTelemetryEvent[]=[]
  constructor({capacity=256}:SandboxTelemetryOptions={}){
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>10_000)throw Error('Telemetry capacity must be between 1 and 10000')
    this.capacity=capacity
  }
  get dropped(){return this.#dropped}
  record(event:EventInput){
    const value=structuredClone({...event,sequence:++this.#sequence}) as SandboxTelemetryEvent
    if(this.#events.length===this.capacity){this.#events.shift();this.#dropped++}
    this.#events.push(value)
  }
  events():SandboxTelemetryEvent[]{return structuredClone(this.#events)}
  drain():SandboxTelemetryEvent[]{const events=this.events();this.#events.length=0;return events}
  clear(){this.#events.length=0;this.#dropped=0}
}
