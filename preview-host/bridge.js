let owner
addEventListener('message', async function boot(event) {
  if (
    event.source !== parent ||
    event.data?.type !== 'attach-workspace' ||
    !event.ports[0] ||
    owner
  )
    return
  owner = event.ports[0]
  owner.start()
  try {
    await navigator.serviceWorker.register('/__sandbox/sw.js', { scope: '/' })
    const registration = await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, {
          once: true,
        })
        // A remounted iframe can be uncontrolled even with an active worker.
        // Registration does not activate that worker again, so request a claim.
        registration.active.postMessage({ type: 'claim-workspace-bridge' })
      })
    owner.postMessage({ type: 'ready' })
  } catch (error) {
    owner.postMessage({ type: 'error', error: String(error) })
  }
})
navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data?.type !== 'request' || !event.ports[0]) return
  if (!owner) {
    event.ports[0].postMessage({ error: 'Workspace bridge has no owner' })
    return
  }
  owner.postMessage(event.data, [event.ports[0]])
})
