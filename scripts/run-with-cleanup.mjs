/** Run cleanup without losing an earlier workflow failure. */
export async function runWithCleanup(run,cleanup){
  let failed=false,failure,result
  try{result=await run()}
  catch(error){failed=true;failure=error}
  try{await cleanup()}
  catch(error){
    if(failed)throw new AggregateError([failure,error],'Workflow and cleanup both failed')
    throw error
  }
  if(failed)throw failure
  return result
}
