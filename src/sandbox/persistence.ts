import type { WorkspaceSnapshot } from './files'
import {openSandboxDatabase} from './database'

// One atomic record per named checkpoint. No silent memory fallback.
export async function checkpoint(
  operation: 'save' | 'load' | 'delete',
  key: string,
  snapshot?: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot | undefined> {
  if (!key) throw new Error('A checkpoint key is required')
  const db = await openSandboxDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        'checkpoints',
        operation === 'load' ? 'readonly' : 'readwrite',
      )
      const store = transaction.objectStore('checkpoints')
      const request =
        operation === 'load'
          ? store.get(key)
          : operation === 'save'
            ? store.put(snapshot, key)
            : store.delete(key)
      transaction.oncomplete = () =>
        resolve(operation === 'load' ? request.result : undefined)
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Checkpoint transaction aborted'))
      // Request errors bubble before the transaction finishes aborting, when
      // transaction.error can still be null. Settle only on complete or abort.
    })
  } finally {
    db.close()
  }
}
