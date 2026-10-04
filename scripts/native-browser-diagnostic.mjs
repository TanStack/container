// Diagnostic failures must not hide the behavior failure that triggered them.
// A timeout is an observation result, never evidence that the app succeeded.
export function browserErrorText(error) {
  if (typeof error?.stack === 'string' && error.stack.trim()) return error.stack
  const name = typeof error?.name === 'string' ? error.name : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  if (message.trim()) return name ? name + ': ' + message : message
  return name || String(error) || 'Browser reported an error without text'
}

export async function diagnosticWithin(operation, timeoutMs = 5000) {
  if (typeof operation !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new TypeError('A diagnostic operation and positive timeout are required')
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(cause => ({ error: String(cause) })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ error: `Diagnostic observation timed out after ${timeoutMs}ms` }), timeoutMs)
      }),
    ])
  } finally { clearTimeout(timer) }
}
