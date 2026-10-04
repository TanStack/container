import {rolldown as browserRolldown} from '@rolldown/browser'
import {volumeResolver} from './volume-resolver'
import {volumeBuildLoader} from './volume-build-loader'

export * from '@rolldown/browser'

/** Give internal compiler calls the same filesystem as guest compiler calls. */
export function rolldown(options:Parameters<typeof browserRolldown>[0]){
  const plugins=options.plugins
  const supplied=Array.isArray(plugins)?plugins:plugins?[plugins]:[]
  if(supplied.flat(Infinity).some(plugin=>plugin&&typeof plugin==='object'&&
    'name' in plugin&&plugin.name==='browser-native-volume-build-loader'))
    return browserRolldown(options)
  const resolver=volumeResolver()
  const loader=volumeBuildLoader()
  // Internal compiler calls have no Vite environment. Let the caller's
  // aliases and package conditions resolve first, then provide file access.
  delete resolver.enforce
  delete loader.enforce
  return browserRolldown({...options,plugins:[
    ...supplied,
    resolver,loader,
  ]})
}
