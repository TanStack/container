export function declaredBuildEvidence(log){
  const evidence=[]
  for(const line of log.split('\n')){
    if(!line.startsWith('DECLARED_BUILD_CLI '))continue
    try{
      const value=JSON.parse(line.slice('DECLARED_BUILD_CLI '.length))
      if(value.exitCode===0&&typeof value.stdout==='string'&&typeof value.stderr==='string'&&
        Number.isInteger(value.outputs)&&value.outputs>0)evidence.push(value)
    }catch{}
  }
  return evidence
}
