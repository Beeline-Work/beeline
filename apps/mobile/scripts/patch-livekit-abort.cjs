const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

// LiveKit 2.22.4 assumes a browser Event constructor in its signal abort
// handler. React Native dispatches abort events without that global on Hermes.
// Patch both distributed entrypoints without checking in a minified UMD bundle.
const root = resolve(__dirname, '../node_modules/livekit-client');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (version !== '2.22.4') {
  throw new Error(`Recheck the Hermes abort fix before using livekit-client ${version}`);
}
const replacements = [
  ['src/api/SignalClient.ts', 'eventOrError instanceof Event', "'currentTarget' in eventOrError"],
  ['dist/livekit-client.esm.mjs', 'eventOrError instanceof Event', "'currentTarget' in eventOrError"],
  ['dist/livekit-client.umd.js', 'e instanceof Event?e.currentTarget:e', '"currentTarget"in e?e.currentTarget:e'],
  // React Native's abort-controller also predates AbortSignal.reason.
  ['src/api/utils.ts', "'toString' in reason ? reason.toString() : defaultMessage", 'reason == null ? defaultMessage : String(reason)'],
  ['dist/livekit-client.esm.mjs', "'toString' in reason ? reason.toString() : defaultMessage", 'reason == null ? defaultMessage : String(reason)'],
  ['dist/livekit-client.umd.js', '"toString"in n?n.toString():t', '(null==n?t:String(n))'],
];
// Validate all files before writing; a dependency change must fail installation.
const updates = new Map();
for (const [file, before, after] of replacements) {
  const path = resolve(root, file);
  const source = updates.get(path) ?? readFileSync(path, 'utf8');
  if (!source.includes(before) && source.includes(after)) continue;
  if (source.split(before).length !== 2) {
    throw new Error(`LiveKit abort patch no longer matches ${file}`);
  }
  updates.set(path, source.replace(before, after));
}
for (const [path, source] of updates) writeFileSync(path, source);
