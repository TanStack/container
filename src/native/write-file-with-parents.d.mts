import type {NativeFileOperations} from './filesystem-operations'
export declare function writeFileWithParents(
  fs:Pick<NativeFileOperations,'lstatSync'|'mkdirSync'|'writeFileSync'>,
  filename:string,contents:Uint8Array,options?:{followSymlinks?:boolean;mode?:number},
):void
