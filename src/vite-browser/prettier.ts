import * as prettier from 'prettier/standalone'
import estree from 'prettier/plugins/estree'
import typescript from 'prettier/plugins/typescript'
import type { Options } from 'prettier'

export * from 'prettier/standalone'

export function format(source: string, options: Options = {}) {
  return prettier.format(source, {
    ...options,
    plugins: [typescript, estree, ...(options.plugins ?? [])],
  })
}
