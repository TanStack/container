export function normalizeSourceError(error:unknown):unknown{
  if(error instanceof Error&&(error as Error&{code?:string}).code==='PARSE_ERROR')
    return new SyntaxError(error.message,{cause:error})
  return error
}
