export const stdinLifecycleSources={
  untouched:'console.log("ready")',
  paused:'process.stdin.resume();process.stdin.pause();console.log("ready")',
  destroyed:'process.stdin.resume();process.stdin.destroy();console.log("ready")',
  resumed:`process.stdin.on('data',chunk=>process.stdout.write(chunk));process.stdin.pause();
setTimeout(()=>process.stdin.resume(),20);console.log('ready');`,
}
