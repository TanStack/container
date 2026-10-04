export function nativeWorkerKind():WorkerType{
  return (globalThis as any)[Symbol.for('tanstack.container.worker-type')]==='classic'?'classic':'module'
}
