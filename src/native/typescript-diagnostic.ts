export interface TypeScriptDiagnostic{
  code:number
  category:number
  message:string
  file?:string
  line?:number
  column?:number
}
