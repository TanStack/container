export class UnsettledTopLevelAwait extends Error{
  constructor(){super('Unsettled top-level await');this.name='UnsettledTopLevelAwait'}
}

/** A cached evaluation promise must not become a new loading resource. */
export class ModuleLoadLifetime{
  private readonly started=new Set<string>()
  private readonly loading=new Map<string,Set<()=>void>>()
  constructor(private readonly acquire:()=>()=>void){}
  evaluating(id:string){
    this.started.add(id)
    for(const release of this.loading.get(id)??[])release()
    this.loading.delete(id)
  }
  load<T>(id:string,load:()=>Promise<T>):Promise<T>{
    if(this.started.has(id))return load()
    const release=this.acquire()
    const loads=this.loading.get(id)??new Set<()=>void>()
    loads.add(release);this.loading.set(id,loads)
    const finish=()=>{
      release();loads.delete(release)
      if(!loads.size&&this.loading.get(id)===loads)this.loading.delete(id)
    }
    try{return load().finally(finish)}
    catch(error){finish();throw error}
  }
}

/** Evaluation promises are not referenced resources. Module loading is. */
export async function awaitModuleEvaluation<T>(evaluation:Promise<T>,waitForIdle:()=>Promise<void>):Promise<T>{
  const result=await Promise.race([
    evaluation.then(value=>({settled:true as const,value})),
    waitForIdle().then(()=>({settled:false as const})),
  ])
  if(!result.settled)throw new UnsettledTopLevelAwait()
  return result.value
}
