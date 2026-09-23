export type VMContextCase = {name:string;code:string} & (
  {kind:'policy';expected:string} | {kind?:undefined;expected?:undefined}
)
export const vmContextCases:VMContextCase[]
