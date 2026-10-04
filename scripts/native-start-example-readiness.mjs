// These pinned React examples mount their existing Router devtools in a
// client effect. This is a test precondition, never an SDK hydration hook.
export async function waitForPinnedStartClient(frame) {
  await frame.getByText('TanStack Router', { exact: true }).waitFor({ timeout: 45000 })
}
