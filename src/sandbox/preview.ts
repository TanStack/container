import type { GuestProcess } from './process'

export interface PreviewState {
  title: string
  text: string
  controls: { tag: string; text: string; id: string }[]
  readyState?: DocumentReadyState
  /** Optional JSON state published by the app as globalThis.__browserSandboxReadiness. */
  readiness?: Record<string, unknown>
}

function previewBridge() {
  addEventListener('message', function boot(event: MessageEvent) {
    if (event.source !== parent || !event.ports[0]) return
    removeEventListener('message', boot)
    const port = event.ports[0]
    addEventListener('error', (event) =>
      port.postMessage({ type: 'diagnostic', message: event.message }),
    )
    addEventListener('unhandledrejection', (event) =>
      port.postMessage({ type: 'diagnostic', message: String(event.reason) }),
    )
    const pending = new Map<
      number,
      { resolve(response: Response): void; reject(error: Error): void }
    >()
    let nextId = 1
    globalThis.fetch = async (input, init) => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(String(input), 'https://sandbox.invalid'), init)
      if (new URL(request.url).origin !== 'https://sandbox.invalid')
        throw new Error('Preview network access denied')
      const id = nextId++
      const body = ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await request.arrayBuffer()
      return new Promise<Response>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        port.postMessage({
          type: 'fetch',
          id,
          url: request.url,
          method: request.method,
          headers: [...request.headers],
          body,
        })
      })
    }
    port.onmessage = async (event) => {
      const message = event.data
      if (message.type === 'fetch-result') {
        const call = pending.get(message.id)
        if (!call) return
        pending.delete(message.id)
        if (message.error) call.reject(new Error(message.error))
        else
          call.resolve(
            new Response(
              [204, 205, 304].includes(message.status) ? null : message.body,
              { status: message.status, headers: message.headers },
            ),
          )
        return
      }
      try {
        if (message.type === 'start') {
          const script = document.createElement('script')
          script.type = 'module'
          const url = URL.createObjectURL(
            new Blob([message.code], { type: 'text/javascript' }),
          )
          script.src = url
          await new Promise<void>((resolve, reject) => {
            script.onload = () => {
              URL.revokeObjectURL(url)
              resolve()
            }
            script.onerror = () => {
              URL.revokeObjectURL(url)
              reject(new Error('Preview script failed'))
            }
            document.body.append(script)
          })
        } else if (message.type === 'click') {
          const element = document.querySelector(message.selector)
          if (!(element instanceof HTMLElement))
            throw new Error('Control not found')
          element.click()
        } else if (message.type !== 'inspect')
          throw new Error('Unknown preview action')
        port.postMessage({
          type: 'result',
          id: message.id,
          value: {
            title: document.title,
            text: document.body.innerText,
            controls: [
              ...document.querySelectorAll(
                'button, input, a, select, textarea',
              ),
            ].map((element) => ({
              tag: element.tagName.toLowerCase(),
              text: element.textContent,
              id: element.id,
            })),
          },
        })
      } catch (error) {
        port.postMessage({
          type: 'result',
          id: message.id,
          error: String(error),
        })
      }
    }
    port.start()
    port.postMessage({ type: 'ready' })
  })
}

export class Preview {
  readonly diagnostics: string[] = []
  readonly frame = document.createElement('iframe')
  #channel = new MessageChannel()
  #nextId = 1
  #pending = new Map<
    number,
    {
      resolve(value: PreviewState): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  #closed = false

  private constructor(readonly server?: GuestProcess) {}

  static async mount(
    container: HTMLElement,
    html: string,
    code: string,
    server?: GuestProcess,
  ): Promise<Preview> {
    const preview = new Preview(server)
    const frame = preview.frame
    frame.title = 'Workspace preview'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    const policy =
      "default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'; worker-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    // External assets need a virtual URL server, not the embedding application's origin.
    // Inline scripts run inside the guest frame, including SSR hydration data.
    const documentCopy = new DOMParser().parseFromString(html, 'text/html')
    documentCopy
      .querySelectorAll('script[src], link, meta[http-equiv], base')
      .forEach((element) => element.remove())
    for (const element of documentCopy.querySelectorAll('*')) {
      for (const attribute of [...element.attributes])
        if (attribute.name.toLowerCase().startsWith('on'))
          element.removeAttribute(attribute.name)
    }
    const script = `(${previewBridge.toString()})()`
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${policy}"><script>${script.replaceAll('</script', '<\\/script')}<\/script>${documentCopy.documentElement.outerHTML}`
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Preview boot timed out')),
          5_000,
        )
        preview.#channel.port1.onmessage = (event) => {
          if (event.data.type === 'ready') {
            clearTimeout(timer)
            resolve()
          } else preview.#message(event.data)
        }
        frame.onload = () => {
          frame.onload = null
          frame.contentWindow!.postMessage({}, '*', [preview.#channel.port2])
        }
        container.append(frame)
      })
      await preview.#call('start', { code })
      return preview
    } catch (error) {
      preview.close()
      throw error
    }
  }

  async #message(message: any) {
    if (this.#closed) return
    if (message.type === 'diagnostic')
      this.diagnostics.push(String(message.message))
    else if (message.type === 'fetch') {
      try {
        if (!this.server) throw new Error('No preview server')
        if (new URL(message.url).origin !== 'https://sandbox.invalid')
          throw new Error('Preview network access denied')
        const response = await this.server.fetch(
          new Request(message.url, {
            method: message.method,
            headers: message.headers,
            body: message.body,
          }),
        )
        this.#channel.port1.postMessage({
          type: 'fetch-result',
          id: message.id,
          status: response.status,
          headers: [...response.headers],
          body: await response.arrayBuffer(),
        })
      } catch (error) {
        this.#channel.port1.postMessage({
          type: 'fetch-result',
          id: message.id,
          error: String(error),
        })
      }
    } else if (message.type === 'result') {
      const call = this.#pending.get(message.id)
      if (!call) return
      this.#pending.delete(message.id)
      clearTimeout(call.timer)
      message.error
        ? call.reject(new Error(message.error))
        : call.resolve(message.value)
    }
  }

  #call(type: string, data = {}): Promise<PreviewState> {
    if (this.#closed) return Promise.reject(new Error('Preview closed'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Preview action timed out'))
      }, 5_000)
      this.#pending.set(id, { resolve, reject, timer })
      this.#channel.port1.postMessage({ ...data, type, id })
    })
  }
  inspect() {
    return this.#call('inspect')
  }
  click(selector: string) {
    return this.#call('click', { selector })
  }
  close() {
    this.#closed = true
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error('Preview closed'))
    }
    this.#pending.clear()
    this.#channel.port1.close()
    this.frame.remove()
  }
}
