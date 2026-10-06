// These pinned React examples mount their existing Router devtools in a
// client effect. This is a test precondition, never an SDK hydration hook.
export async function waitForPinnedStartClient(frame, timeoutMs = 45000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000)
    throw new TypeError('Pinned client readiness requires a timeout from 1 to 45000ms')
  await frame.getByText('TanStack Router', { exact: true }).waitFor({ timeout: timeoutMs })
}
