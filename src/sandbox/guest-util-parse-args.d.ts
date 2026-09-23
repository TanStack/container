export interface GuestParseArgsOption {type:'string'|'boolean';short?:string;multiple?:boolean;default?:unknown}
export interface GuestParseArgsConfig {args?:string[];options?:Record<string,GuestParseArgsOption>;strict?:boolean;allowPositionals?:boolean;tokens?:boolean;allowNegative?:boolean}
export function parseArgs(config?:GuestParseArgsConfig):{values:Record<string,unknown>;positionals:string[];tokens?:Record<string,unknown>[]}
