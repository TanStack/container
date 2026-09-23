// QuickJS stacks contain frames without the name/message line used by Node.
export function formatGuestConsoleError(error) {
  const name = error.name || 'Error'
  const message = error.message || ''
  const heading = message ? `${name}: ${message}` : name
  const stack = error.stack
  if (typeof stack !== 'string' || !stack) return heading
  return stack === heading || stack.startsWith(`${heading}\n`) ? stack : `${heading}\n${stack}`
}
