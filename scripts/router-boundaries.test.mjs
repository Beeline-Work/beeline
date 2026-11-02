import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource, judgeInventory, scanRouterTree, baselineInventory } from './router-boundaries.mjs';

const core = 'packages/net/src/example.ts';
const dispatcherSource = `import { Agent } from 'undici';
class MemberStreamAgent extends Agent {
  override dispatch(options: Parameters<Agent['dispatch']>[0], handler: Parameters<Agent['dispatch']>[1]): ReturnType<Agent['dispatch']> {
    return super.dispatch({ ...options, bodyTimeout: 0 }, handler);
  }
}
const memberStreamAgent = new MemberStreamAgent();
function request(url, stream) { return fetch(url, { ...(stream ? { dispatcher: memberStreamAgent } : {}) }); }`;
test('MCP idle dispatcher only configures the existing inventoried fetch', () => {
  const result = inspectSource('apps/body/src/session-join/beeline-api.ts', dispatcherSource);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.hits.map(hit => hit.kind), ['fetch']);
});
test('dispatcher aliases, exports, direct calls and altered SDK wrappers remain network boundaries', () => {
  for (const source of [
    `${dispatcherSource}\nconst escape = memberStreamAgent;`,
    `${dispatcherSource}\nmemberStreamAgent.dispatch(options, handler);`,
    `${dispatcherSource}\nexport { memberStreamAgent };`,
    `${dispatcherSource}\nconst other = new Agent();`,
    `${dispatcherSource}\nconst Factory = MemberStreamAgent;`,
    dispatcherSource.replace('bodyTimeout: 0', 'bodyTimeout: options.bodyTimeout'),
    dispatcherSource.replace('{ Agent }', '{ Agent, request as anotherRequest }'),
  ]) assert.ok(inspectSource('apps/body/src/session-join/beeline-api.ts', source).hits.some(hit => hit.kind === 'import:undici'));
  assert.ok(inspectSource('apps/body/src/elsewhere.ts', dispatcherSource).hits.some(hit => hit.kind === 'import:undici'));
});
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

test('the narrow public phone observer is allowed but owner factories remain private', () => {
  assert.deepEqual(inspectSource('apps/mobile/sources/example.ts', 'import { observePhoneInput } from \"@beeline/net/phone-inputs\";').errors, []);
  assert.ok(inspectSource('packages/net/src/phone-inputs.ts', 'export { AdmissionOwner } from \"./private/admission.js\";').errors.length);
});


test('only exact persisted owner may access the command executor, including aliases', () => {
  for (const source of ['socket.requestCommand(op,args,id)', 'const send = socket.requestCommand;', 'socket["requestCommand"](op,args,id)'])
    assert.ok(inspectSource('apps/mobile/sources/feature.ts', source).errors.length);
  assert.deepEqual(inspectSource('apps/mobile/sources/buzz/command-owner.ts', 'socket.requestCommand(op,args,id)').errors, []);
});


test('owner admission cannot escape through aliases, reexports or namespace access', () => {
  for (const source of [
    'import { routerOwnerArtifactAction as mint } from "@/buzz/router-owner";',
    'export { routerOwnerArtifactAction } from "@/buzz/router-owner";',
    'export * from "@/buzz/router-owner";',
    'import * as owner from "@/buzz/router-owner";',
    'const owner = require("@/buzz/router-owner");',
    'const owner = await import("@/buzz/router-owner");',
    'owner["routerOwnerArtifactAction"]("OpenArtifact", id);',
  ]) assert.ok(inspectSource('apps/mobile/sources/feature.ts', source).errors.length, source);
  assert.deepEqual(inspectSource('apps/mobile/sources/components/buzz/ArtifactCard.tsx',
    'import { routerOwnerArtifactAction as act } from "@/buzz/router-owner";').errors, []);
  assert.ok(inspectSource('apps/mobile/sources/components/buzz/ArtifactCard.tsx',
    'import { routerOwnerArtifactViewport } from "@/buzz/router-owner";').errors.length);
  assert.deepEqual(inspectSource('apps/mobile/sources/feature.ts',
    'import { routerFamilyMode } from "@/buzz/router-owner";').errors, []);
});


test('features cannot install a substitute media or usage executor', () => {
  for (const source of [
    'import { installMediaCacheConnection as replace } from "@/buzz/media-cache-connection";',
    'import { receiveMediaAuthorityRemoval } from "./buzz/media-cache-connection";',
    'export * from "@/buzz/media-cache-connection";',
    'import * as media from "@/buzz/media-cache-connection";',
    'const usage = require("@/buzz/agent-usage-cell");',
    'import { setUsageCellProfile as mint } from "@/buzz/agent-usage-cell";',
  ]) assert.ok(inspectSource('apps/mobile/sources/feature.ts', source).errors.length, source);
  assert.deepEqual(inspectSource('apps/mobile/sources/buzz/router-owner.ts',
    'import { installMediaCacheConnection } from "./media-cache-connection";').errors, []);
  assert.deepEqual(inspectSource('apps/mobile/sources/components/File.tsx',
    'import { mediaMetadataFor } from "@/buzz/media-cache-connection";').errors, []);
});

 test('usage admission belongs only to committed profile or desktop pane owners', () => {
  const source = 'import { routerOwnerUsageProfile } from "@/buzz/router-owner";';
  for (const path of ['app/(app)/beeline/agent-profile.tsx', 'app/(app)/beeline/chat/_chat-surface.tsx'])
    assert.deepEqual(inspectSource('apps/mobile/sources/' + path, source).errors, []);
  for (const path of ['buzz/use-agent-usage-cell.ts', 'components/buzz/AgentUsageSection.tsx', 'components/buzz/AgentProfileView.tsx'])
    assert.ok(inspectSource('apps/mobile/sources/' + path, source).errors.length);
});

test('closed helper usage codecs are restricted to the existing machine adapters', () => {
  const source = 'import { helperUsageCodecs } from "@beeline/net/helper-codecs";';
  for (const file of ['apps/body/src/helper-usage-channel.ts', 'apps/server/src/daemon-live.ts'])
    assert.deepEqual(inspectSource(file, source).errors, []);
  for (const file of ['apps/body/src/feature.ts', 'apps/server/src/phone-operations.ts', 'apps/mobile/sources/buzz/feature.ts'])
    assert.ok(inspectSource(file, source).errors.length);
  assert.ok(inspectSource('packages/net/src/helper-codecs.ts', 'export { AdmissionOwner } from "./private/admission.js";').errors.length);
});

test('closed turn controls cannot escape their two existing machine adapters', () => {
  const source = 'import { helperTurnCodecs } from "@beeline/net/helper-turn-codecs";';
  for (const file of ['apps/body/src/helper-turn-channel.ts', 'apps/server/src/daemon-live.ts'])
    assert.deepEqual(inspectSource(file, source).errors, []);
  for (const file of ['apps/body/src/feature.ts', 'apps/server/src/phone-operations.ts', 'apps/mobile/sources/buzz/feature.ts'])
    assert.ok(inspectSource(file, source).errors.length);
  assert.ok(inspectSource('packages/net/src/helper-turn-codecs.ts', 'export { AdmissionOwner } from "./private/admission.js";').errors.length);
});

 test('closed activation codec is restricted to machine adapters', () => {
  const source = 'import { helperActivationCodecs } from "@beeline/net/helper-activation-codecs";';
  for (const file of ['apps/body/src/helper-activation-channel.ts', 'apps/server/src/daemon-live.ts'])
    assert.deepEqual(inspectSource(file, source).errors, []);
  for (const file of ['apps/body/src/feature.ts', 'apps/server/src/phone-operations.ts', 'apps/mobile/sources/buzz/feature.ts'])
    assert.ok(inspectSource(file, source).errors.length);
  assert.ok(inspectSource('packages/net/src/helper-activation-codecs.ts', 'export { AdmissionOwner } from "./private/admission.js";').errors.length);
});

test('Tray command and paint authority cannot escape their declared viewport and gesture wrappers',()=>{
  for(const name of ['admitRouterTrayCommand','admitRouterTrayPaint','acquireRouterSavedContinuation']){
    const source=`import { ${name} as mint } from '@/buzz/router-owner';`;
    assert.deepEqual(inspectSource('apps/mobile/sources/buzz/router-tray.ts',source).errors,[]);
    assert.ok(inspectSource('apps/mobile/sources/feature.ts',source).errors.length);
  }
  for(const source of [
    "import { prepareTrayCommand as mint } from '@/buzz/router-tray';",
    "import { acknowledgeRoutedTrayPaint } from './buzz/router-tray';",
    "export * from '@/buzz/router-tray';",
    "const mint=require('@/buzz/router-tray');",
    "import * as tray from '@/buzz/router-tray';",
  ])assert.ok(inspectSource('apps/mobile/sources/feature.ts',source).errors.length);
  assert.deepEqual(inspectSource('apps/mobile/sources/app/(app)/beeline/tray.tsx',
    "import { prepareTrayCommand, acknowledgeRoutedTrayPaint, useRoutedTray } from '@/buzz/router-tray';").errors,[]);
});
