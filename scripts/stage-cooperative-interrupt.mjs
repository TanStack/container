// Only used by the isolated Asyncify scheduling candidate.
export function stageCooperativeInterrupt(source,profileYields=false){
  const before=`  // Async not supported here.
  // #ifdef QTS_ASYNCIFY
  //   const asyncify = Asyncify;
  // #else
  const asyncify = undefined;
  // #endif
  return Module['callbacks']['shouldInterrupt'](asyncify, rt);`
  if(source.split(before).length!==2)throw Error('Unexpected interrupt callback source')
  return source.replace(before,`  var now = performance.now();
  // A resumed call must enter handleSleep to finish rewinding, even when the
  // next CPU slice has not expired. Only normal execution can use the fast path.
  if (Asyncify.state === Asyncify.State.Normal &&
      (Module['cooperativeScheduling'] === false || now - (Module['lastInterruptYield'] || 0) < 8)) {
    return Module['callbacks']['shouldInterrupt'](undefined, rt);
  }
  return Asyncify.handleSleep(function(done) {
    ${profileYields?`var metrics = Module['cooperativeMetrics'] || (Module['cooperativeMetrics'] = {yields:0,waitMs:0,maxWaitMs:0});
    metrics.yields++;`:''}
    var schedule = Module['scheduleCooperativeYield'] || function(resume) { setTimeout(resume, 0); };
    schedule(function() {
      ${profileYields?`var waited = performance.now() - now;
      metrics.waitMs += waited; metrics.maxWaitMs = Math.max(metrics.maxWaitMs, waited);`:''}
      Module['lastInterruptYield'] = performance.now();
      done(Module['callbacks']['shouldInterrupt'](undefined, rt));
    });
  });`)
}
