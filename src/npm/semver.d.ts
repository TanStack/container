declare module 'semver' {
  export function validRange(range:string):string|null
  export function satisfies(version:string,range:string):boolean
  export function maxSatisfying(versions:string[],range:string):string|null
}
