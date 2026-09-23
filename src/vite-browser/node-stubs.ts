export class Worker {
  constructor() {
    throw new Error('worker_threads is unavailable in browser Vite')
  }
}
export const MessageChannel = globalThis.MessageChannel
export const performance = globalThis.performance
export const parentPort = null
export const workerData = undefined
export const receiveMessageOnPort = () => undefined
export const promises = {
  lookup: async (hostname: string) => ({ address: hostname, family: 0 }),
}
export const exec = () => { throw new Error('child_process is unavailable in browser Vite') }
export const execFile = exec
export const execSync = exec
export const spawn = exec
export const createServer = exec
export const get = exec
export const connect = exec
export const isIP = () => 0
export const STATUS_CODES: Record<number, string> = {}
export const constants: Record<string, number> = {}
export const isatty = () => false
export const serialize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
export const deserialize = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value))
export const transform = () => { throw new Error('lightningcss is unavailable in browser Vite') }
export const pipeline = async (...streams: unknown[]) => streams.at(-1)
export const browserslistToTargets = () => ({})
export const composeVisitors = (...visitors: unknown[]) => visitors
export const Features: Record<string, number> = {}
export default { MessageChannel, Worker, constants, exec, execFile, execSync, promises, spawn }
