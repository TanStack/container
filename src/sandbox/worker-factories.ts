import KernelWorker from './kernel.worker?worker'
import CompilerWorker from './compiler.worker?worker'
import ShellWorker from './mvdan-shell.worker?worker'
import BrowserCompilerWorker from '../compiler/browser-compiler-bundled.worker?worker'

// The lab lets Vite own worker URLs. The packaged SDK replaces this internal
// module with factories that resolve workers from its deployed asset directory.
export function createKernelWorker(_assetBaseURL?:string):Worker{return new KernelWorker()}
export function createCompilerWorker(_assetBaseURL?:string):Worker{return new CompilerWorker()}
export function createShellWorker(_assetBaseURL?:string):Worker{return new ShellWorker()}
export function createBrowserCompilerWorker(_assetBaseURL?:string):Worker{return new BrowserCompilerWorker()}
