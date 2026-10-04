const symbol=Symbol.for('web-container:native-process-exit')

export class NativeProcessExit extends Error{
  readonly [symbol]=true
  constructor(readonly code:number){super(`Process exited with code ${code}`);this.name='NativeProcessExit'}
}

export function isNativeProcessExit(error:unknown):error is NativeProcessExit{
  return !!error&&typeof error==='object'&&(error as Record<symbol,unknown>)[symbol]===true
}
