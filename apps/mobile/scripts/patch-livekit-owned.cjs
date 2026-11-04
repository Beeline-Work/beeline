const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Pin the extra semantics of maxRetries:0 used by Beeline's call owner:
// one signal attempt, no speculative region fetch, backoff or protocol replay.
// Keep default SDK behavior for callers that have not selected that policy.
function patchLivekitOwned(root) {
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (version !== '2.22.4') throw new Error(`Recheck owned voice admission for livekit-client ${version}`);
  const replacements = [
    ['src/room/Room.ts', "if (isCloud(new URL(url))) {\n      if (this.regionUrlProvider", "if (opts?.maxRetries !== 0 && isCloud(new URL(url))) {\n      if (this.regionUrlProvider"],
    ['src/room/Room.ts', 'await BackOffStrategy.getInstance().getBackOffPromise(url);', 'if (opts?.maxRetries !== 0) await BackOffStrategy.getInstance().getBackOffPromise(url);'],
    ['src/room/Room.ts', 'this.regionUrlProvider &&\n          error instanceof ConnectionError', 'opts?.maxRetries !== 0 && this.regionUrlProvider &&\n          error instanceof ConnectionError'],
    ['src/room/RTCEngine.ts', 'e.reason === ConnectionErrorReason.ServiceNotFound)', 'opts.maxRetries !== 0 && e.reason === ConnectionErrorReason.ServiceNotFound)'],
    ['dist/livekit-client.esm.mjs', "if (isCloud(new URL(url))) {\n        if (this.regionUrlProvider", "if (opts?.maxRetries !== 0 && isCloud(new URL(url))) {\n        if (this.regionUrlProvider"],
    ['dist/livekit-client.esm.mjs', 'yield BackOffStrategy.getInstance().getBackOffPromise(url);', 'if (opts?.maxRetries !== 0) yield BackOffStrategy.getInstance().getBackOffPromise(url);'],
    ['dist/livekit-client.esm.mjs', 'if (this.regionUrlProvider && error instanceof ConnectionError', 'if (opts?.maxRetries !== 0 && this.regionUrlProvider && error instanceof ConnectionError'],
    ['dist/livekit-client.esm.mjs', 'e.reason === ConnectionErrorReason.ServiceNotFound)', 'opts.maxRetries !== 0 && e.reason === ConnectionErrorReason.ServiceNotFound)'],
    ['dist/livekit-client.umd.js', 'mo(new URL(t))&&(void 0===this.regionUrlProvider?', '(!i||0!==i.maxRetries)&&mo(new URL(t))&&(void 0===this.regionUrlProvider?'],
    ['dist/livekit-client.umd.js', 'yield Oc.getInstance().getBackOffPromise(t),u.signal.aborted', 'yield(!i||0!==i.maxRetries?Oc.getInstance().getBackOffPromise(t):Promise.resolve()),u.signal.aborted'],
    ['dist/livekit-client.umd.js', 'if(this.regionUrlProvider&&h instanceof Xs&&Zs(h))', 'if((!i||0!==i.maxRetries)&&this.regionUrlProvider&&h instanceof Xs&&Zs(h))'],
    ['dist/livekit-client.umd.js', 'n.reason===e.ConnectionErrorReason.ServiceNotFound)', '0!==r.maxRetries&&n.reason===e.ConnectionErrorReason.ServiceNotFound)'],
  ];
  const updates = new Map();
  for (const [file, before, after] of replacements) {
    const path = resolve(root, file);
    const source = updates.get(path) ?? readFileSync(path, 'utf8');
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error(`LiveKit owned admission patch no longer matches ${file}`);
    updates.set(path, source.replace(before, after));
  }
  for (const [path, source] of updates) writeFileSync(path, source);
}
module.exports = { patchLivekitOwned };
if (require.main === module) patchLivekitOwned(resolve(__dirname, '../node_modules/livekit-client'));
