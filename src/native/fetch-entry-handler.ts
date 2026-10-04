type FetchHandler=(request:Request)=>Response|Promise<Response>

function exportedFetch(module:Record<string,unknown>):FetchHandler{
  const fallback=module.default
  const candidate=module.fetch
    ??(fallback&&typeof fallback==='object'?(fallback as Record<string,unknown>).fetch:undefined)
    ??(typeof fallback==='function'?fallback:undefined)
  if(typeof candidate!=='function')throw Error('Entry module does not export a fetch handler')
  return candidate as FetchHandler
}

/** Publish a validated handler without changing requests already in flight. */
export class FetchEntryHandler {
  #handler:FetchHandler
  constructor(module:Record<string,unknown>){this.#handler=exportedFetch(module)}
  fetch(request:Request){const handler=this.#handler;return handler(request)}
  replace(module:Record<string,unknown>){
    const next=exportedFetch(module)
    const previous=this.#handler
    this.#handler=next
    return ()=>{this.#handler=previous}
  }
}
