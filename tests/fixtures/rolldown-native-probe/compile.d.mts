export const files:Record<string,string>
export function compile(binding:unknown,callback:(method:string,args:unknown[])=>Promise<unknown>,cwd?:string):Promise<Array<{code:string;filename:string}>>
