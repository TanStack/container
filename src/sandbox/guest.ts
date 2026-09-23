import bootstrap from './guest-runtime.js?raw'
import { IncomingRequest } from './incoming-request'

export const guestPolicy =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

export interface GuestConnection {
  port: MessagePort
  close(): void
}

// Guest code never runs in this frame's main thread, only in its child worker.
// This keeps a runaway guest from blocking our termination message.
export function createGuest(signal: AbortSignal): Promise<GuestConnection> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Guest cancelled'))
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('sandbox', 'allow-scripts')
    const channel = new MessageChannel()
    let done = false
    const close = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      channel.port1.close()
      frame.remove()
    }
    const abort = () => {
      close()
      if (!done) reject(new Error('Guest cancelled'))
    }
    const timer = setTimeout(() => {
      close()
      reject(new Error('Opaque-origin worker boot timed out'))
    }, 10_000)
    signal.addEventListener('abort', abort, { once: true })
    channel.port1.onmessage = (event) => {
      if (event.data.type === 'boot-error') {
        close()
        reject(new Error(event.data.error))
        return
      }
      if (event.data.type !== 'ready') return
      done = true
      clearTimeout(timer)
      channel.port1.onmessage = null
      resolve({ port: channel.port1, close })
    }
    const script = `addEventListener('message', function boot(event) {
      if (event.source !== parent || !event.ports[0]) return;
      removeEventListener('message', boot);
      const host = event.ports[0];
      try {
        const url = URL.createObjectURL(new Blob([${JSON.stringify(`const IncomingRequest = (${IncomingRequest.toString()});\n` + bootstrap)}], { type: 'text/javascript' }));
        const worker = new Worker(url);
        const bridge = new MessageChannel();
        host.onmessage = e => bridge.port1.postMessage(e.data);
        bridge.port1.onmessage = e => host.postMessage(e.data);
        worker.onerror = e => host.postMessage({ type: 'boot-error', error: e.message || 'Guest worker failed to load' });
        worker.postMessage({}, [bridge.port2]);
      } catch (error) { host.postMessage({ type: 'boot-error', error: String(error) }); }
    });`
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${guestPolicy}"><script>${script.replaceAll('</script', '<\\/script')}<\/script>`
    frame.onload = () => {
      frame.onload = null
      frame.contentWindow!.postMessage({}, '*', [channel.port2])
    }
    document.body.append(frame)
  })
}
