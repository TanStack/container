import { Workspace } from '../sandbox/workspace'

export async function runSynchronousIO() {
  const workspace = new Workspace({
    files: {
      '/value': 'before',
      '/probe.mjs': `import {readFileSync,writeFileSync} from 'node:fs';
      console.log('host-edit');
      const live=readFileSync('/value','utf8');
      writeFileSync('/binary',new Uint8Array([0,128,255]));
      for(let i=0;i<100;i++)readFileSync('/value','utf8');
      console.log(JSON.stringify({live,bytes:Array.from(readFileSync('/binary')),reads:100,guestSharedArrayBuffer:typeof SharedArrayBuffer,fetch:typeof fetch}));`,
      '/readonly.mjs': `import {writeFileSync} from 'node:fs';writeFileSync('/denied','no')`,
    },
  })
  try {
    const run = await workspace.executeInVM('/probe.mjs', {
      engine: 'asyncify',
      timeoutMs: 10000,
      onOutput: (_level, text) => {
        if (text.trim() === 'host-edit')
          void workspace.files.writeText('/value', 'host-updated')
      },
    })
    if (run.exitCode) throw new Error(run.stderr)
    const data = JSON.parse(run.stdout.trim().split('\n').at(-1)!)
    if (
      data.live !== 'host-updated' ||
      JSON.stringify(data.bytes) !== '[0,128,255]' ||
      data.fetch !== 'undefined'
    )
      throw new Error(
        'Synchronous I/O result mismatch: ' + JSON.stringify(data),
      )
    const readonly = await workspace.executeInVM('/readonly.mjs', {
      engine: 'asyncify',
      writable: false,
    })
    if (
      !readonly.stderr.includes('read-only') ||
      (await workspace.files.exists('/denied'))
    )
      throw new Error('Read-only authority failed')
    return {
      status: 'pass',
      ...data,
      // QuickJS's own JS constructor is not the browser's shared-memory API.
      hostSharedArrayBuffer: typeof SharedArrayBuffer,
      crossOriginIsolated,
      durationMs: run.duration,
      readOnlyDenied: true,
      scope: 'Synchronous modules only, not a Node event loop',
    }
  } finally {
    workspace.close()
  }
}
