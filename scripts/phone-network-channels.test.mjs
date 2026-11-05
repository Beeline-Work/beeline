import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST_PATH, TRANSPORT_FILE } from './phone-network-channels.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowlist = {
  packageRoots: ['packages/api-contract/src', 'packages/buzz-client/src', 'packages/nostr/src'],
  entries: [
    [TRANSPORT_FILE, 'websocket', 'main-socket'],
    ['apps/mobile/sources/buzz/store-update.ts', 'fetch', 'exception'],
    ['packages/buzz-client/src/auth-json.ts', 'fetch', 'exception'],
    ['packages/api-contract/src/system-message-catalog.ts', 'origin:github.com', 'link'],
    ['apps/mobile/sources/settings.ts', 'origin:github.com', 'link'],
  ].map(([file, kind, fate]) => ({ file, kind, fate, count: 1, why: 'A channel in the small test fixture.' })),
};
const scratch = mkdtempSync(path.join(tmpdir(), 'phone-network-channels-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(name = 'tree') {
  const root = mkdtempSync(path.join(scratch, name + '-'));
  for (const [file, source] of Object.entries({
    [ALLOWLIST_PATH]: JSON.stringify(allowlist),
    [TRANSPORT_FILE]: 'export const connect = url => new WebSocket(url);',
    'apps/mobile/sources/buzz/store-update.ts': "export const check = () => fetch('/minimum');",
    'apps/mobile/sources/sync/transport/monolith-operation.ts': 'export const operation = () => undefined;',
    'apps/mobile/sources/settings.ts': "import '@beeline/buzz-client';\nimport '@beeline/api-contract';\nexport const link = 'https://github.com/settings';",
    'packages/buzz-client/package.json': JSON.stringify({ exports: { '.': './dist/index.js' } }),
    'packages/buzz-client/src/index.ts': "export * from './auth-json.js';\n",
    'packages/buzz-client/src/auth-json.ts': "export const auth = () => fetch('/auth');",
    'packages/api-contract/package.json': JSON.stringify({ exports: { '.': './dist/index.js' } }),
    'packages/api-contract/src/index.ts': "export * from './system-message-catalog.js';",
    'packages/api-contract/src/system-message-catalog.ts': "export const link = 'https://github.com/fix';",
  })) write(root, file, source);
  return root;
}

function runCheck(root, ...extra) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts/check-phone-network-channels.mjs'), '--root', root, ...extra], {
    encoding: 'utf8',
  });
}

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

test('a failed screen read cannot open a fetch or socket recovery door', () => {
  const root = fixture('read-recovery-backdoor');
  assert.equal(runCheck(root).status, 0);
  write(root, 'apps/mobile/sources/buzz/read-recovery-backdoor.ts', [
    "export const readRoomElsewhere = (url: string) => fetch(url, { method: 'POST' });",
    'export const reconnectElsewhere = (url: string) => new WebSocket(url);',
  ].join('\n'));
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new phone network call site \(fetch\).*read-recovery-backdoor\.ts:1/);
  assert.match(result.stderr, /new phone network call site \(websocket\).*read-recovery-backdoor\.ts:2/);
});
