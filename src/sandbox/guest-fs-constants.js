// Portable access, copy, and file-type constants for the virtual filesystem.
// This is not the complete legacy node:constants module.
export const F_OK=0,R_OK=4,W_OK=2,X_OK=1;
// Stable virtual ABI, independent of the browser host operating system.
export const O_RDONLY=0,O_WRONLY=1,O_RDWR=2,O_CREAT=64,O_EXCL=128,O_TRUNC=512,O_APPEND=1024;
export const COPYFILE_EXCL=1,COPYFILE_FICLONE=2,COPYFILE_FICLONE_FORCE=4;
export const S_IFMT=0o170000,S_IFREG=0o100000,S_IFDIR=0o040000,S_IFLNK=0o120000;
export const S_IFBLK=0o060000,S_IFCHR=0o020000,S_IFIFO=0o010000,S_IFSOCK=0o140000;
export default {F_OK,R_OK,W_OK,X_OK,O_RDONLY,O_WRONLY,O_RDWR,O_CREAT,O_EXCL,O_TRUNC,O_APPEND,COPYFILE_EXCL,COPYFILE_FICLONE,COPYFILE_FICLONE_FORCE,S_IFMT,S_IFREG,S_IFDIR,S_IFLNK,S_IFBLK,S_IFCHR,S_IFIFO,S_IFSOCK};
