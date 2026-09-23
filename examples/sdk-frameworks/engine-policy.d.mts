export interface ExampleEnginePolicy {
  profile:string
  options:{cooperative:false}|{experimentalFibers:true;experimentalRolldownParser:{timeoutMs:number;maxSourceBytes:number}}
  requiresIsolation:boolean
}

export function exampleEnginePolicy(manifest:any):ExampleEnginePolicy
