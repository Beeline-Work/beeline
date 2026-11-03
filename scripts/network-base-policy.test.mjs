import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkTrustedNetworkBase } from './check-network-base.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
function fixture({ phone = true, router = true, body = false } = {}) {
  const proof = path.join(repo, '.beeline-proof');
  mkdirSync(proof, { recursive: true });
  const root = mkdtempSync(path.join(proof, 'network-base-test-'));
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
  };
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const entry = { id: 'apps/body/src/transport.ts::fetch', file: 'apps/body/src/transport.ts',
    kind: 'fetch', count: 1, compatibility: 'legacy-only', phase: 'M5' };
  write('.gitignore', '.beeline-proof/\nnode_modules\n');
  if (phone) write('scripts/phone-network-channels.mjs', readFileSync(path.join(repo, 'scripts/phone-network-channels.mjs')));
  if (router) write('scripts/router-boundaries.mjs', readFileSync(path.join(repo, 'scripts/router-boundaries.mjs')));
  write('apps/mobile/network-channels.json', JSON.stringify({ schema: 1, packageRoots: [], entries: [] }));
  write('packages/net/migration-sites.json', JSON.stringify({ schema: 1, entries: body ? [entry] : [] }));
  if (body) write(entry.file, 'export const request = () => fetch("https://example.test");');
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'trusted base']);
  symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return { root, write, entry, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('unchanged phone and router policies pass without loading proposed scanner code', async () => {
  const f = fixture();
  try {
    f.write('scripts/phone-network-channels.mjs', 'throw new Error("Do not execute proposed scanner");');
    f.write('scripts/router-boundaries.mjs', 'throw new Error("Do not execute proposed scanner");');
    assert.deepEqual((await checkTrustedNetworkBase(f.root, 'HEAD')).errors, []);
  } finally { f.close(); }
});

test('emptying the proposed scanner cannot hide a new phone network leaf', async () => {
  const f = fixture();
  try {
    f.write('scripts/phone-network-channels.mjs', 'export const scanPhoneTree = () => new Map();');
    f.write('apps/mobile/sources/escape.ts', 'const request = globalThis.fetch; request("/escape");');
    const result = await checkTrustedNetworkBase(f.root, 'HEAD');
    assert.ok(result.errors.some(error => /trusted phone: new phone network call site/.test(error)));
  } finally { f.close(); }
});

test('emptying the proposed router scanner cannot hide a helper network leaf', async () => {
  const f = fixture();
  try {
    f.write('scripts/router-boundaries.mjs', 'export const scanRouterTree = () => ({sites:new Map(),errors:[]});');
    f.write('apps/body/src/escape.ts', 'fetch("/escape");');
    const result = await checkTrustedNetworkBase(f.root, 'HEAD');
    assert.ok(result.errors.some(error => /trusted router: undeclared network boundary/.test(error)));
  } finally { f.close(); }
});

test('moving a network leaf and rewriting its manifest does not reset trusted debt', async () => {
  const f = fixture({ body: true });
  try {
    f.write(f.entry.file, 'export const moved = true;');
    const file = 'apps/body/src/moved.ts';
    f.write(file, 'fetch("/moved");');
    f.write('packages/net/migration-sites.json', JSON.stringify({ schema: 1,
      entries: [{ ...f.entry, id: `${file}::fetch`, file }] }));
    const result = await checkTrustedNetworkBase(f.root, 'HEAD');
    assert.ok(result.errors.some(error => /trusted router: migration debt cannot grow/.test(error)));
  } finally { f.close(); }
});

test('bootstrap retains the original phone guard when the base has no router scanner', async () => {
  const f = fixture({ router: false });
  try {
    assert.deepEqual((await checkTrustedNetworkBase(f.root, 'HEAD')).errors, []);
    f.write('apps/mobile/sources/escape.ts', 'new WebSocket("wss://example.test");');
    const result = await checkTrustedNetworkBase(f.root, 'HEAD');
    assert.equal(result.routerAtBase, false);
    assert.ok(result.errors.some(error => error.startsWith('trusted phone:')));
  } finally { f.close(); }
});

test('missing and option-shaped base refs fail closed', async () => {
  const f = fixture();
  try {
    for (const base of [undefined, '', '--help', 'missing-base'])
      await assert.rejects(checkTrustedNetworkBase(f.root, base));
  } finally { f.close(); }
});

test('a missing trusted phone scanner cannot silently bootstrap from the proposed one', async () => {
  const f = fixture({ phone: false, router: false });
  try {
    f.write('scripts/phone-network-channels.mjs', readFileSync(path.join(repo, 'scripts/phone-network-channels.mjs')));
    await assert.rejects(checkTrustedNetworkBase(f.root, 'HEAD'), /phone-network-channels/);
  } finally { f.close(); }
});

test('a copied CI driver checks the explicit tree and returns failure for a scanner bypass', () => {
  const f = fixture();
  try {
    f.write('ci-driver.mjs', readFileSync(path.join(repo, 'scripts/check-network-base.mjs')));
    f.write('scripts/phone-network-channels.mjs', 'export const scanPhoneTree = () => new Map();');
    f.write('apps/mobile/sources/escape.ts', 'fetch("/escape");');
    const result = spawnSync(process.execPath, [path.join(f.root, 'ci-driver.mjs'), '--root', f.root, '--base', 'HEAD'],
      { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /trusted phone: new phone network call site/);
  } finally { f.close(); }
});

test('TYPECHECK retains both head scanners and invokes the base-owned driver', () => {
  const tasks = readFileSync(path.join(repo, 'scripts/ci-workspace-tasks.sh'), 'utf8');
  assert.match(tasks, /node scripts\/check-phone-network-channels.mjs --base "\$CHANNEL_BASE"/);
  assert.match(tasks, /node scripts\/check-router-boundaries.mjs --base "\$CHANNEL_BASE"/);
  assert.match(tasks, /git show "\$CHANNEL_BASE:scripts\/check-network-base.mjs" > "\$network_guard"/);
  assert.match(tasks, /node "\$network_guard" --root "\$PWD" --base "\$CHANNEL_BASE"/);
  assert.doesNotMatch(tasks, /check-network-base[^\n]*\|\| true/);
});
