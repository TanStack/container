/** Read complete test exit lines in the framework owner's output format. */
export function parseFrameworkScriptResults(output){
  if(typeof output!=='string')throw new TypeError('Framework script output must be a string')
  return [...output.matchAll(/^test exited with status (\d+)\r?\n/gm)].map(match=>{
    const exitStatus=Number(match[1])
    if(!Number.isSafeInteger(exitStatus))throw new Error('Invalid framework script exit status')
    return {exitStatus}
  })
}

/** Capture beforeCount before clicking Run. A missing count increment fails closed. */
export function extractFreshFrameworkScriptResult(output,beforeCount){
  if(!Number.isSafeInteger(beforeCount)||beforeCount<0)throw new TypeError('Invalid prior framework script result count')
  const records=parseFrameworkScriptResults(output)
  if(records.length!==beforeCount+1)throw new Error(`Expected exactly one newly completed test invocation, found ${records.length-beforeCount}`)
  return {...records[beforeCount],output}
}
