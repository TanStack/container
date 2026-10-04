import { constants, promises as filePromises } from './node-fs'

export { constants }
export const {
  access,
  appendFile,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
  watch,
} = filePromises
export default filePromises
