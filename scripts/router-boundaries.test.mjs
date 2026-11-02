import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource, judgeInventory, scanRouterTree, baselineInventory } from './router-boundaries.mjs';

const core = 'packages/net/src/example.ts';
for (const [name, source] of Object.entries({
  'alias fetch': 'const f = fetch; f("/api");',
  'global alias': 'const g = globalThis; g.fetch("/api");',
  'computed global': 'globalThis["fet" + "ch"]("/api");',
  'SDK': 'import { Client } from "openai";',
  'wrapper escape': 'import { request } from "../../../../apps/body/src/transport.js";',
  'dynamic import': 'import("./hidden.js");',
  'computed import': 'import(name);',
  'eval': 'eval(code);',
  'node networking': 'import { request } from "node:https";',
})) test(`core rejects ${name}`, () => assert.ok(inspectSource(core, source).errors.length));

test('core allows only local pure imports and erased types', () => {
  assert.deepEqual(inspectSource(core, 'import { routes } from "./routes.js"; import type { PhoneOperationMap } from "@beeline/api-contract/phone";').errors, []);
});

test('public barrel cannot leak factories; feature reexports cannot bypass private ownership', () => {
  assert.ok(inspectSource('packages/net/src/index.ts', 'export { AdmissionOwner } from "./private/admission.js";').errors.length);
  for (const file of ['apps/mobile/sources/view.ts', 'apps/body/src/helper.ts', 'apps/server/src/route.ts', 'packages/buzz-client/src/proxy.ts']) {
    assert.ok(inspectSource(file, 'export { AdmissionOwner } from "@beeline/net/private/admission";').errors.length);
    assert.ok(inspectSource(file, 'const owner = import("@beeline/net/dist/private/admission.js");').errors.length);
  }
  assert.ok(inspectSource('apps/body/src/helper.ts', 'import { AdmissionOwner } from "../../../packages/net/src/private/admission.js";').errors.length);
});

test('native networking and moved networking remain declared boundaries', () => {
  assert.ok(inspectSource('apps/mobile/modules/example.swift', 'URLSession.shared.dataTask(with: url)').hits.length);
  assert.ok(inspectSource('apps/mobile/src-tauri/src/lib.rs', 'let client = reqwest::Client::new();').hits.length);
  const entry = { id: 'apps/body/src/a.ts::fetch', file: 'apps/body/src/a.ts', kind: 'fetch', count: 1, compatibility: 'legacy-only', phase: 'M5' };
  const sites = new Map([[entry.id, entry]]);
  assert.deepEqual(judgeInventory(sites, { entries: [entry] }, { entries: [entry] }), []);
  assert.ok(judgeInventory(sites, { entries: [entry] }, { entries: [] }).some(x => x.includes('cannot grow')));
  assert.ok(judgeInventory(new Map(), { entries: [entry] }).some(x => x.includes('stale')));
  assert.ok(judgeInventory(sites, { entries: [] }).some(x => x.includes('undeclared')));
  const grown = { ...entry, count: 2 };
  assert.ok(judgeInventory(new Map([[entry.id, grown]]), { entries: [grown] }, { entries: [entry] }).some(x => x.includes('cannot grow')));
});

test('bootstrap compares changed and new sources to trusted base, not the proposed inventory', () => {
  const proof = fileURLToPath(new URL('../.beeline-proof/', import.meta.url));
  mkdirSync(proof, { recursive: true });
  const root = mkdtempSync(path.join(proof, 'router-boundary-'));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    mkdirSync(path.join(root, 'apps/body/src'), { recursive: true });
    writeFileSync(path.join(root, 'apps/body/src/a.ts'), 'export const value = 1;');
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base']);
    writeFileSync(path.join(root, 'apps/body/src/a.ts'), 'fetch("/old-file-new-call");');
    writeFileSync(path.join(root, 'apps/body/src/new.ts'), 'fetch("/new-file");');
    const { sites } = scanRouterTree(root);
    const baseline = baselineInventory(root, 'HEAD', sites);
    assert.equal(baseline.entries.length, 0);
    assert.equal(judgeInventory(sites, { entries: [...sites.values()] }, baseline).filter(x => x.includes('cannot grow')).length, 2);
    assert.throws(() => baselineInventory(root, 'missing-base', sites));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public reachability follows proxy modules transitively', () => {
  const proof = fileURLToPath(new URL('../.beeline-proof/', import.meta.url));
  mkdirSync(proof, { recursive: true });
  const root = mkdtempSync(path.join(proof, 'router-imports-'));
  try {
    mkdirSync(path.join(root, 'packages/net/src/private'), { recursive: true });
    writeFileSync(path.join(root, 'packages/net/src/index.ts'), 'export * from "./proxy.js";');
    writeFileSync(path.join(root, 'packages/net/src/proxy.ts'), 'export * from "./private/admission.js";');
    writeFileSync(path.join(root, 'packages/net/src/private/admission.ts'), 'export const mint = () => ({});');
    assert.ok(scanRouterTree(root).errors.some(x => x.includes('reachable from public API')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('core cannot hide a transport in an imported test-named module', () => {
  const proof = fileURLToPath(new URL('../.beeline-proof/', import.meta.url));
  mkdirSync(proof, { recursive: true });
  const root = mkdtempSync(path.join(proof, 'router-hidden-'));
  try {
    mkdirSync(path.join(root, 'packages/net/src'), { recursive: true });
    writeFileSync(path.join(root, 'packages/net/src/index.ts'), 'import "./helper.test.js";');
    writeFileSync(path.join(root, 'packages/net/src/helper.test.ts'), 'fetch("/hidden");');
    assert.ok(scanRouterTree(root).errors.some(x => x.includes('transport-free')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
