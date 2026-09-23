import { Workspace } from './workspace'
import { Preview } from './preview'

export const workflowFiles = {
  '/math.ts': 'export const add = (a: number, b: number) => a - b',
  '/test.ts': `import { add } from './math'; if (add(2, 3) !== 5) throw new Error('Expected 5, received ' + add(2, 3)); console.log('1 test passed')`,
  '/server.ts': `import { readFile, writeFile } from 'node:fs/promises';
    import { add } from './math';
    export default { async fetch(request: Request) {
      if (new URL(request.url).pathname === '/api/add') {
        await writeFile('/last-result.txt', String(add(2, 3)));
        return Response.json({ result: add(2, 3) });
      }
      return new Response('<h1>Browser workspace</h1><button id="calculate">Calculate 2 + 3</button><output id="result"></output>', { headers: { 'content-type': 'text/html' } });
    } }`,
  '/client.ts': `document.querySelector('#calculate')!.addEventListener('click', async () => {
    const data = await (await fetch('/api/add')).json();
    document.querySelector('#result')!.textContent = String(data.result);
  })`,
}

// Deterministic agent tool sequence. No model calls or pretense of autonomous reasoning.
export async function runWorkflow(
  container: HTMLElement,
  log: (text: string) => void,
) {
  const workspace = new Workspace({ files: workflowFiles })
  let preview: Preview | undefined
  try {
    const failed = await workspace.execute('/test.ts')
    if (!failed.exitCode)
      throw new Error('The intentionally failing test unexpectedly passed')
    log(
      'Expected failure before repair: ' +
        failed.stderr.split('\n')[0].replace(/^(Error:\s*)+/, ''),
    )
    await workspace.files.patch('/math.ts', 'a - b', 'a + b')
    const passed = await workspace.execute('/test.ts')
    if (passed.exitCode) throw new Error(passed.stderr)
    log(passed.stdout.trim())
    const server = await workspace.serve('/server.ts')
    const html = await (await server.fetch('https://sandbox.invalid/')).text()
    const client = await workspace.bundle('/client.ts')
    preview = await Preview.mount(container, html, client.code, server)
    await preview.click('#calculate')
    const deadline = performance.now() + 3_000
    while (!(await workspace.files.exists('/last-result.txt'))) {
      if (performance.now() > deadline)
        throw new Error('Preview did not reach the workspace server')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    log(
      'Preview click reached the server, result: ' +
        (await workspace.files.readText('/last-result.txt')),
    )
    await workspace.save('agent-workflow')
    const restored = await Workspace.open('agent-workflow')
    const replay = await restored.execute('/test.ts')
    restored.close()
    if (replay.exitCode) throw new Error(replay.stderr)
    log('Checkpoint restored and test passed again')
    return { workspace, preview }
  } catch (error) {
    preview?.close()
    workspace.close()
    throw error
  }
}
