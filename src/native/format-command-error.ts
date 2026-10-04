export function formatCommandError(reason: unknown): string {
  if (!(reason instanceof Error)) return String(reason)
  const message = String(reason)
  const captured = reason.stack
  const stack = captured && workerSourceLocations.mapStack(captured)
  if (!stack) return message
  return stack.startsWith(message) ? stack : `${message}\n${stack}`
}
import {workerSourceLocations} from './browser-source-locations'
