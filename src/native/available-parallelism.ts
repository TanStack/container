/** Parallelism hint for this browser runtime, not host CPU topology. */
export function availableParallelism(){
  const hint=globalThis.navigator?.hardwareConcurrency
  return typeof hint==='number'&&Number.isFinite(hint)&&hint>=1?Math.floor(hint):1
}
