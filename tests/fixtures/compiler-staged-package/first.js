import add from 'workspace:shared'
import ignored from './disabled.js'
import {WorkerValue} from './worker.ts'
export const answer=add(1)
export const name=WorkerValue.name
export const disabled=ignored.active
