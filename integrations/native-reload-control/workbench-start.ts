import { createMiddleware, createStart } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'

const isolation = createMiddleware().server(({ next }) => {
  setResponseHeader('Cross-Origin-Opener-Policy', 'same-origin')
  setResponseHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  setResponseHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  setResponseHeader('Cache-Control', 'no-store')
  return next()
})

export const startInstance = createStart(() => ({ requestMiddleware: [isolation] }))
