import fs, { constants } from './node-fs'

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
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} = fs.promises
export default fs.promises
