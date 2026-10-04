const bindingKey=Symbol.for('web-container:rolldown-binding')
const disposeKey=Symbol.for('napi.rs.wasi.dispose')

/** Drain native work and stop the browser WASI worker pool before shutdown. */
export async function disposeBrowserRolldown(){
  const registry=globalThis as typeof globalThis & {[key:symbol]:unknown}
  const binding=registry[bindingKey] as {[key:symbol]:unknown}|undefined
  if(!binding)return
  const dispose=binding[disposeKey]
  if(typeof dispose!=='function')throw Error('Rolldown browser binding has no WASI disposer')
  await dispose.call(binding)
  delete registry[bindingKey]
}
