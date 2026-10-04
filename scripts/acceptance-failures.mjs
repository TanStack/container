export function recordAcceptanceFailure(failures,details,error,continueOnFailure){
  if(!continueOnFailure)throw error
  failures.push(error)
  return {...details,status:'failed',error:String(error)}
}

export function assertAcceptancePassed(failures,label){
  if(failures.length)throw new AggregateError(failures,`${failures.length} ${label} checks failed`)
}
