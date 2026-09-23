// An incoming server request is not an outgoing browser fetch. Browser Request
// constructors drop Origin, Cookie and Sec-* headers, so retain the transport's
// header collection separately while keeping native body and URL behavior.
export class IncomingRequest extends Request {
  #incomingHeaders: Headers
  constructor(input: string | URL | Request, init: RequestInit = {}) {
    super(input, init)
    this.#incomingHeaders = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    )
  }
  override get headers() {
    return this.#incomingHeaders
  }
  override clone() {
    return new IncomingRequest(super.clone(), { headers: this.headers })
  }
}
