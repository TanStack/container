import { compileProject, initializeCompiler, stopCompiler } from '../compiler/compile'
import { WorkspaceFiles } from './files'

self.onmessage = async (event) => {
  let reply
  try {
    // This worker already owns the execution boundary. Do not create a nested
    // worker whose Go service outlives the parent's completion notification.
    await initializeCompiler(false)
    self.postMessage({ type: 'ready' })
    // The owning workspace already admitted this snapshot against its limits.
    // Do not impose the default workspace quota on callers with larger limits.
    const files=new WorkspaceFiles({},Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);files.replace(event.data.snapshot)
    const result = await compileProject(
      files,
      event.data.entry,
      event.data.options,
    )
    reply={result}
  } catch (error) {
    reply={
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try { await stopCompiler() }
    catch(error){ reply={error:'Compiler cleanup failed: '+String(error)} }
  }
  self.postMessage(reply)
}
