export interface BrowserSourcePosition {file:string;line:number;column:number}
type PositionMapper=(line:number,column:number)=>BrowserSourcePosition|null

/** Translate captured locations only, never add missing frames. */
export class BrowserSourceLocations {
  #sources=new Map<string,PositionMapper>()
  register(url:string,mapper:PositionMapper){
    if(this.#sources.has(url))throw Error(`Source URL already registered: ${url}`)
    this.#sources.set(url,mapper)
    return ()=>{if(this.#sources.get(url)===mapper)this.#sources.delete(url)}
  }
  mapStack(stack:string){
    return stack.split('\n').map(frame=>{
      for(const [url,mapper] of this.#sources){
        const index=frame.lastIndexOf(url)
        if(index<0)continue
        const tail=frame.slice(index+url.length)
        const match=/^:(\d+):(\d+)(\)?\s*)$/.exec(tail)
        if(!match)continue
        const mapped=mapper(Number(match[1]),Number(match[2]))
        if(!mapped||!Number.isInteger(mapped.line)||mapped.line<1||!Number.isInteger(mapped.column)||mapped.column<1)continue
        return frame.slice(0,index)+`${mapped.file}:${mapped.line}:${mapped.column}`+match[3]
      }
      return frame
    }).join('\n')
  }
}
export const workerSourceLocations=new BrowserSourceLocations()
let enabled=false
export function enableBrowserSourceLocations(){enabled=true}
export function browserSourceLocationsEnabled(){return enabled}
