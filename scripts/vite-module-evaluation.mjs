import assert from 'node:assert/strict'

// Pinned Vite 8 corrections for updates that arrive before their original
// browser-native module evaluation finishes. No application-specific behavior.
// Exact anchors fail the build when the pinned source changes unexpectedly.
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length - 1, 1, 'Vite module lifetime anchor changed: ' + before)
  return source.replace(before, () => after)
}

const REGISTRY = String.raw`this.deferredUpdates = new Map();
this.loadedRevisions = new Map();
this.pendingImports = new Map();
this.failedImports = new Set();
this.evaluationObservers = new Map();
this.evaluationObserverTokens = new Map();
this.nextEvaluationObserverToken = 0;`

const LIFETIME_METHODS = String.raw`
  deferUpdate(update) {
    let dependencies = this.deferredUpdates.get(update.path);
    if (!dependencies) this.deferredUpdates.set(update.path, dependencies = new Map());
    const previous = dependencies.get(update.acceptedPath);
    if (!previous || update.timestamp >= previous.timestamp) dependencies.set(update.acceptedPath, update);
  }
  replayDeferredUpdates(path) {
    if (!this.deferredUpdates.has(path)) return;
    queueMicrotask(() => {
      const dependencies = this.deferredUpdates.get(path);
      if (!dependencies) return;

      if (this.pendingImports.has(path)) return;
      for (const [accepted, update] of [...dependencies]) {
        if (this.pendingImports.has(accepted)) continue;
        dependencies.delete(accepted);
        if (update.timestamp <= (this.loadedRevisions.get(accepted) ?? 0)) continue;
        this.queueUpdate(update).catch(error => this.logger.error(error));
      }
      if (!dependencies.size) this.deferredUpdates.delete(path);
    });
  }
  dropDeferredUpdates(paths) {
    const removed = new Set(paths);
for (const path of removed) { this.loadedRevisions.delete(path); this.pendingImports.delete(path); this.failedImports.delete(path); }
this.disposeEvaluationObservers(removed);
    for (const [owner, dependencies] of this.deferredUpdates) {
      if (removed.has(owner)) { this.deferredUpdates.delete(owner); continue; }
      for (const dependency of dependencies.keys()) if (removed.has(dependency)) dependencies.delete(dependency);
      if (!dependencies.size) this.deferredUpdates.delete(owner);
    }
  }

  trackImport(path, load) {
    const original = load();
    let state = this.pendingImports.get(path);
    if (!state) this.pendingImports.set(path, state = {count: 0, failed: false});
    state.count++;
    const settle = (failed = false) => {
      state.failed ||= failed;
      state.count--;
      if (this.pendingImports.get(path) !== state || state.count) return;
      this.pendingImports.delete(path);
      if (state.failed) this.failedImports.add(path); else this.failedImports.delete(path);
      for (const [owner, dependencies] of this.deferredUpdates) {
        if (owner === path || dependencies.has(path)) this.replayDeferredUpdates(owner);
      }
    };
    return original.then(value => { settle(); return value; }, error => { settle(true); throw error; });
  }

  disposeEvaluationObservers(paths) {
    for (const [path, jobs] of this.evaluationObservers) {
      if (paths && !paths.has(path)) continue;
      for (const job of jobs) {
        job.cancelled = true;
        this.evaluationObserverTokens.delete(job.token);
        job.resolve(null);
      }
      this.evaluationObservers.delete(path);
    }
  }
  markEvaluationObserverStarted(token) {
    const job = this.evaluationObserverTokens.get(token);
    if (job && !job.cancelled && job.token === token) job.started = true;
  }
  observeEvaluation(path, target, observerBase, load) {
    const job = {path, target, observerBase, load, attempts: 0, lastRetryTimestamp: 0,
      observing: false, started: false, failedObserver: null, cancelled: false};
    const completion = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    let jobs = this.evaluationObservers.get(path);
    if (!jobs) this.evaluationObservers.set(path, jobs = new Set());
    jobs.add(job);
    job.completion = completion;
    completion.catch(() => {});
    // Register the exact identity now, request native settlement only when an
    // update is actually waiting for this path. Do not infer completion from
    // registration, hot acceptance, a microtask or a timer.
    for (const [owner, dependencies] of this.deferredUpdates) {
      if (owner === path || dependencies.has(path)) { this.startEvaluationObserver(job); break; }
    }
    return completion;
  }
  requestEvaluationObservers(path, acceptedPath) {
    for (const key of new Set([path, acceptedPath])) {
      for (const job of this.evaluationObservers.get(key) ?? []) {
        if (!job.cancelled && !job.observing && !job.failedObserver) this.startEvaluationObserver(job);
      }
    }
  }
  startEvaluationObserver(job) {
    if (job.cancelled || job.observing) return;
    if (!job.tracked) {
      job.tracked = this.trackImport(job.path, () => job.completion);
      job.tracked.catch(() => {});
    }
    job.observing = true;
    job.started = false;
    job.failedObserver = null;
    job.attempts++;
    job.token = ++this.nextEvaluationObserverToken;
    this.evaluationObserverTokens.set(job.token, job);
    const token = job.token;
    const payload = btoa(JSON.stringify([job.target, token, 'observe'])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const remove = () => {
      this.evaluationObserverTokens.delete(token);
      job.observing = false;
    };
    const finish = (failed, value) => {
      remove();
      const jobs = this.evaluationObservers.get(job.path);
      jobs?.delete(job);
      if (!jobs?.size) this.evaluationObservers.delete(job.path);
      if (failed) job.reject(value); else job.resolve(value);
    };
    Promise.resolve().then(() => job.load(job.observerBase + payload)).then(namespace => {
      if (job.cancelled || job.token !== token) return;
      finish(false, namespace);
    }, error => {
      if (job.cancelled || job.token !== token) return;
      if (job.started) { finish(true, error); return; }
      // Failure before the linked graph's first dependency executes is not an
      // application evaluation failure. Keep the ownership promise pending.
      remove();
      if (job.attempts < 2) { this.startEvaluationObserver(job); return; }
      job.failedObserver = error;
      const diagnostic = {code: 'VITE_MODULE_EVALUATION_OBSERVER_UNAVAILABLE', path: job.path,
        target: job.target, attempts: job.attempts,
        message: 'Cannot observe module evaluation for ' + job.path + '. Its hot update is waiting, not applied.'};
      this.logger.error(diagnostic.message);
      this.notifyListeners('vite:module-evaluation-observer-error', diagnostic);
    });
  }
  retryFailedEvaluationObservers(path, acceptedPath, timestamp) {
    for (const key of new Set([path, acceptedPath])) {
      for (const job of this.evaluationObservers.get(key) ?? []) {
        if (!job.failedObserver || job.observing || timestamp <= job.lastRetryTimestamp) continue;
        job.lastRetryTimestamp = timestamp;
        job.attempts = 0;
        this.startEvaluationObserver(job);
      }
    }
  }
  async fetchUpdate(update) {
    this.requestEvaluationObservers(update.path, update.acceptedPath);
    this.retryFailedEvaluationObservers(update.path, update.acceptedPath, update.timestamp);`

const CLIENT_EXPORTS = String.raw`function trackModuleImport(path, load) { return hmrClient.trackImport(path, load); }
function recordModuleRevision(path, timestamp) { hmrClient.loadedRevisions.set(path, timestamp); }

function observeModuleEvaluation(path, target, observerBase) {
  return hmrClient.observeEvaluation(path, target, observerBase, url => import(/* @vite-ignore */ url));
}
function markModuleEvaluationObserverStarted(token) { hmrClient.markEvaluationObserverStarted(token); }
export { ErrorOverlay, createHotContext, injectQuery, removeStyle, updateStyle, trackModuleImport, recordModuleRevision, observeModuleEvaluation, markModuleEvaluationObserverStarted };`

const REVISION_PREFIX = String.raw`const revisionPrefix = !ssr && !importer.startsWith(withTrailingSlash(clientDir)) && !importer.startsWith('\0tanstack-module-evaluation:') && !(importer.includes('worker_file') && importer.includes('type=classic'))
        ? 'import {recordModuleRevision as __vite__recordModuleRevision,observeModuleEvaluation as __vite__observeModuleEvaluation} from ' + JSON.stringify(clientPublicPath) + ';__vite__recordModuleRevision(' + JSON.stringify(importerModule.url) + ',' + (importerModule.lastHMRTimestamp ?? 0) + ');__vite__observeModuleEvaluation(' + JSON.stringify(importerModule.url) + ',import.meta.url,' + JSON.stringify(joinUrlSegments(base, wrapId('\0tanstack-module-evaluation:'))) + ');' : '';`

const OBSERVER_PLUGIN = String.raw`!isBuild && !isWorker ? {
      name: 'vite:module-evaluation-observer',
      applyToEnvironment(environment) { return environment.config.consumer === 'client' && !environment.config.isBundled; },
      resolveId(id) { if (id.startsWith('\0tanstack-module-evaluation:')) return id; },
      load(id) {
        if (!id.startsWith('\0tanstack-module-evaluation:')) return;
        const payload = id.slice('\0tanstack-module-evaluation:'.length).replace(/-/g, '+').replace(/_/g, '/');
        const [target, token, phase] = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        const targetUrl = new URL(target);
        if (!['http:', 'https:'].includes(targetUrl.protocol) || !Number.isSafeInteger(token) || token < 1) throw new Error('Invalid evaluation observer module');
        if (phase === 'start') return 'import {markModuleEvaluationObserverStarted} from ' + JSON.stringify(joinUrlSegments(config.base || '/', CLIENT_PUBLIC_PATH)) + ';markModuleEvaluationObserverStarted(' + token + ');';
        if (phase !== 'observe') throw new Error('Invalid evaluation observer phase');
        const startPayload = Buffer.from(JSON.stringify([target, token, 'start']), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const startUrl = '\0tanstack-module-evaluation:' + startPayload;
        return 'import ' + JSON.stringify(startUrl) + ';import * as namespace from ' + JSON.stringify(targetUrl.href) + ';export default namespace;';
      }
    } : null,`

export function coordinateViteModuleEvaluationClient(source) {
  assert.ok(!source.includes('evaluationObservers'), 'Vite module lifetime already installed')
  source = replaceOnce(source, 'this.hmrClient.hotModulesMap.set(this.ownerPath, mod);',
    'this.hmrClient.hotModulesMap.set(this.ownerPath, mod);\nthis.hmrClient.replayDeferredUpdates(this.ownerPath);')
  source = replaceOnce(source, '_defineProperty(this, "pendingUpdateQueue", false);',
    '_defineProperty(this, "pendingUpdateQueue", false);\n' + REGISTRY)
  source = replaceOnce(source, 'this.hotModulesMap.clear();',
    'this.deferredUpdates.clear();\nthis.loadedRevisions.clear();\nthis.pendingImports.clear();\nthis.failedImports.clear();\nthis.disposeEvaluationObservers();\nthis.hotModulesMap.clear();')
  source = replaceOnce(source, 'async prunePaths(paths) {', 'async prunePaths(paths) {\nthis.dropDeferredUpdates(paths);')
  source = replaceOnce(source, 'async fetchUpdate(update) {', LIFETIME_METHODS)
  source = replaceOnce(source, 'if (!mod) return;',
    'if (this.pendingImports.has(path) || this.pendingImports.has(acceptedPath) || (!mod && !(path === acceptedPath && this.failedImports.has(path)))) { this.deferUpdate(update); return; }')
  source = replaceOnce(source, 'const qualifiedCallbacks = mod.callbacks.filter(({ deps }) => deps.includes(acceptedPath));',
    'const qualifiedCallbacks = mod?.callbacks.filter(({ deps }) => deps.includes(acceptedPath)) ?? [];')
  source = replaceOnce(source, 'fetchedModule = await this.importUpdatedModule(update);',
    'fetchedModule = await this.importUpdatedModule(update);\nthis.failedImports.delete(acceptedPath);')
  source = replaceOnce(source, 'function createHotContext(ownerPath) {',
    'function createHotContext(ownerPath, loadedTimestamp = 0) {\nhmrClient.loadedRevisions.set(ownerPath, loadedTimestamp);')
  source = replaceOnce(source, 'export { ErrorOverlay, createHotContext, injectQuery, removeStyle, updateStyle };', '\n' + CLIENT_EXPORTS)
  return source
}

export function coordinateViteModuleEvaluationCompiler(source) {
  assert.ok(!source.includes('vite:module-evaluation-observer'), 'Vite module lifetime already installed')
  source = replaceOnce(source,
    'str().prepend(`import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";import.meta.hot = __vite__createHotContext(${JSON.stringify(importerModule.url)});`);',
    'str().prepend(`import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";import.meta.hot = __vite__createHotContext(${JSON.stringify(importerModule.url)}, ${importerModule.lastHMRTimestamp ?? 0});`);')
  source = replaceOnce(source, 'let needQueryInjectHelper = false;', 'let needQueryInjectHelper = false;\nlet trackedDynamicImports = false;')
  source = replaceOnce(source, 'const moduleUrl = unwrapId(stripBase(url, base));', String.raw`const moduleUrl = unwrapId(stripBase(url, base));
        if (isDynamicImport && !ssr && !isExternalUrl(url) && !isDataUrl(url)) {
          trackedDynamicImports = true;
          const trackedPath = unwrapId(stripBase(removeTimestampQuery(url), base));
          str().prependLeft(expStart, '__vite__trackModuleImport(' + JSON.stringify(trackedPath) + ', () => ');
          str().appendRight(expEnd, ')');
        }`)
  source = replaceOnce(source, 'const _orderedImportedUrls = orderedImportedUrls.filter(isDefined);', String.raw`if (trackedDynamicImports) str().prepend('import {trackModuleImport as __vite__trackModuleImport} from ' + JSON.stringify(clientPublicPath) + ';');
      const _orderedImportedUrls = orderedImportedUrls.filter(isDefined);`)
  source = replaceOnce(source, 'if (!importerModule) throwOutdatedRequest(importer);', 'if (!importerModule) throwOutdatedRequest(importer);\n      ' + REVISION_PREFIX)
  source = replaceOnce(source, 'return source;\n\t\t\t}\n\t\t\tlet hasHMR = false;', 'return revisionPrefix + source;\n\t\t\t}\n\t\t\tlet hasHMR = false;')
  source = replaceOnce(source, 'const str = () => s || (s = new MagicString(source));', 'const str = () => s || (s = new MagicString(source));\nif (revisionPrefix) str().prepend(revisionPrefix);')
  source = replaceOnce(source, '\t\t...prePlugins,\n\t\tmodulePreload', '\n    ' + OBSERVER_PLUGIN + '\n\t\t...prePlugins,\n\t\tmodulePreload')
  return source
}
