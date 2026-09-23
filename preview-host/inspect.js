;(() => {
  globalThis.document?.currentScript?.remove()
  const diagnostics = []
  let port
  const report = (message) => {
    diagnostics.push(String(message))
    port?.postMessage({ type: 'diagnostic', message: String(message) })
  }
  addEventListener('error', (event) => report(event.message))
  addEventListener('unhandledrejection', (event) => report(event.reason))
  // Parsing can finish while deferred app modules are still being compiled.
  // Inspection readiness is not an application hydration signal.
  const announce = () => {
    if (document.readyState === 'loading') return
    document.removeEventListener('readystatechange', announce)
    parent.postMessage({ type: 'sandbox-inspection-ready' }, '*')
  }
  const readiness = () => {
    const value = globalThis.__browserSandboxReadiness
    if (!value || typeof value !== 'object') return undefined
    const json = JSON.stringify(value)
    if (json.length > 16384) throw new Error('Preview readiness state is too large')
    return JSON.parse(json)
  }
  document.addEventListener('readystatechange', announce)
  addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== 'inspect-workspace' ||
      !event.ports[0]
    )
      return
    port?.close()
    port = event.ports[0]
    port.onmessage = (event) => {
      const { id, type, selector } = event.data
      try {
        if (type === 'click') {
          const target = document.querySelector(selector)
          if (!(target instanceof HTMLElement))
            throw new Error('Control not found')
          target.click()
        } else if (type !== 'inspect') throw new Error('Unknown preview action')
        port.postMessage({
          type: 'result',
          id,
          value: {
            title: document.title,
            text: document.body.innerText,
            url: location.href,
            readyState: document.readyState,
            readiness: readiness(),
            controls: [
              ...document.querySelectorAll('button,input,a,select,textarea'),
            ].map((element) => ({
              tag: element.tagName.toLowerCase(),
              text: element.textContent,
              id: element.id,
            })),
          },
        })
      } catch (error) {
        port.postMessage({ type: 'result', id, error: String(error) })
      }
    }
    port.postMessage({ type: 'ready', diagnostics })
  })
  announce()
})()
