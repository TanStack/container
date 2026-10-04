import fs,{vol} from '../vite-browser/node-fs'
import {registerCompilerFilesystem} from './compiler-filesystem-registry'

export const sharedCompilerFilesystem=registerCompilerFilesystem({fs,vol})
