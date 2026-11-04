import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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


test('tool page admission belongs only to the existing explicit disclosure boundary',()=>{
  assert.deepEqual(inspectSource('apps/mobile/sources/components/buzz/ActivityTimeline.tsx',
    'import { readRouterToolPage } from "@/buzz/router-owner";').errors,[]);
  assert.ok(inspectSource('apps/mobile/sources/components/Feature.tsx',
    'import { readRouterToolPage } from "@/buzz/router-owner";').errors.length);
});


test('display resource authority stays within its four declared consumer adapters', () => {
  const source = 'import { useRoutedResource } from "./router-resource";';
  for (const name of ['use-room-workflow-run', 'workbench-surface', 'wallet-surface'])
    assert.deepEqual(inspectSource(`apps/mobile/sources/buzz/${name}.ts`, source).errors, []);
  for (const source of [
    'import { useRoutedResource as escape } from "./router-resource";',
    'export { useRoutedResource } from "./router-resource";',
    'import * as resource from "./router-resource";',
    'import("./router-resource");',
  ]) assert.ok(inspectSource('apps/mobile/sources/buzz/feature.ts', source).errors.length);
  assert.deepEqual(inspectSource('apps/mobile/sources/app/(app)/beeline/members.tsx',
    'import { useRoutedResource } from "@/buzz/router-resource";').errors, []);
  const owner = 'import { acquireRouterLane, retryRouterLane } from "./router-owner";';
  assert.deepEqual(inspectSource('apps/mobile/sources/buzz/router-resource.ts', owner).errors, []);
  for (const name of ['use-room-workflow-run', 'workbench-surface', 'wallet-surface'])
    assert.ok(inspectSource(`apps/mobile/sources/buzz/${name}.ts`, owner).errors.length);
});


test('roster query and Room picker gestures stay in their declared adapters and screens',()=>{
  for(const [name,adapter] of [['acquireRouterRosterQuery','use-routed-roster'],['acquireRouterRoomRoster','use-room-roster']]){
    const source=`import { ${name} } from './router-owner';`;
    assert.deepEqual(inspectSource(`apps/mobile/sources/buzz/${adapter}.ts`,source).errors,[]);
    assert.ok(inspectSource('apps/mobile/sources/buzz/feature.ts',source).errors.length);
  }
  for(const [hook,module,screen] of [['useRoutedRoster','use-routed-roster','members.tsx'],['useRoomRoster','use-room-roster','chat/_chat-surface.tsx']]){
    const source=`import { ${hook} } from '@/buzz/${module}';`;
    assert.deepEqual(inspectSource(`apps/mobile/sources/app/(app)/beeline/${screen}`,source).errors,[]);
    assert.ok(inspectSource('apps/mobile/sources/buzz/feature.ts',source).errors.length);
    assert.ok(inspectSource('apps/mobile/sources/buzz/feature.ts',`export * from '@/buzz/${module}';`).errors.length);
  }
});

test('helper operation capability has one owner, including aliases and extra methods inside owner files', () => {
  for (const source of [
    `api.channel.requestOperation('postRoomMessage', input)`,
    `const escape = api.channel['requestOperation'];`,
    `const {requestOperation: send} = channel;`,
    `const raw = api.channel; raw[method](name,input);`,
    `const raw = api.channel.turn; raw.request(name,input);`,
    `import {HelperTurnChannel as Another} from './helper-turn-channel.js';`,
    `export * from './helper-usage-channel.js';`,
    `const raw = await import('./helper-turn-channel.js');`,
    `const raw = require('./machine-link.js');`,
    `export {MachineLink as ExtraSocket} from './machine-link.js';`,
    `channel.turn.request('claimAgentCommand', input)`,
    `channel['usage']['request']('postAgentUsage', input)`,
    `channel.activation.request(input)`,
    `channel.send({type:'daemon-operation', operation:'postRoomMessage', input})`,
  ]) assert.ok(inspectSource('apps/body/src/feature.ts', source).errors.some(x => x.includes('helper operation authority')), source);
  for (const [file, source] of [
    ['apps/body/src/machine-helper.ts', `import {HelperTurnChannel} from './helper-turn-channel.js';`],
    ['apps/body/src/daemon-api-client.ts', `import {HelperUsageChannel as Raw} from './helper-usage-channel.js';`],
    ['apps/body/src/machine-link.ts', `class AgentChannel { extra() { this.send({type:'daemon-operation', input}); } }`],
    ['apps/body/src/daemon-api-client.ts', `class DaemonApiClient { extra() { return this.channel.requestOperation(name,input); } }`],
    ['apps/body/src/daemon-api-client.ts', `class DaemonApiClient { extra() { return fetch('/v1/daemon/operations/postRoomMessage'); } }`],
    ['apps/body/src/daemon-api-client.ts', `class DaemonApiClient { extra() { return this.#requestHttp(name,input); } }`],
  ]) assert.ok(inspectSource(file, source).errors.some(x => x.includes('helper operation authority')), source);
  assert.deepEqual(inspectSource('apps/body/src/daemon-api-client.ts', `class DaemonApiClient {
    execute(name,input) { return this.channel.requestOperation(name,input); }
    async #requestHttp() { return fetch('/v1/daemon/operations/getDaemonBootstrap'); }
  }`).errors, []);
});

test('the tree guard rejects a planted helper backdoor even if its fetch inventory is unchanged', () => {
  const proof = fileURLToPath(new URL('../.beeline-proof/', import.meta.url));
  mkdirSync(proof, {recursive: true});
  const root = mkdtempSync(path.join(proof, 'helper-owner-'));
  try {
    mkdirSync(path.join(root, 'apps/body/src'), {recursive: true});
    const file = path.join(root, 'apps/body/src/feature.ts');
    writeFileSync(file, 'export const innocent = true;');
    assert.deepEqual(scanRouterTree(root).errors, []);
    writeFileSync(file, `export const backdoor = channel => channel['requestOperation']('postRoomMessage', {});`);
    const planted = scanRouterTree(root);
    assert.equal(planted.sites.size, 0);
    assert.ok(planted.errors.some(x => x.includes('helper operation authority')));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('a second ordinary, turn or raw-send caller fails semantic typecheck against the actual public channel view', () => {
  const parse = name => {
    const file = fileURLToPath(new URL('../apps/body/src/' + name, import.meta.url));
    return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  };
  const client = parse('daemon-api-client.ts'), machine = parse('machine-link.ts');
  const clientClass = client.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'DaemonApiClient');
  const channelClass = machine.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AgentChannel');
  const view = clientClass.members.find(node => node.name?.getText(client) === 'channel').type.getText(client);
  const members = channelClass.members.filter(node => node.name && !ts.isPrivateIdentifier(node.name))
    .map(node => JSON.stringify(node.name.getText(machine)) + ': unknown').join(';');
  // Isolate the real public type, with no library/application execution. The
  // compiler must reject all three planted capability reads, not just calls.
  const text = `type Pick<T,K extends keyof T> = {[P in K]:T[P]};
    type Readonly<T> = {readonly [P in keyof T]:T[P]};
    type AgentChannel = {${members}};
    declare const channel: ${view};
    channel.requestOperation; channel.turn; channel.send;`;
  const source = ts.createSourceFile('helper-backdoor.ts', text, ts.ScriptTarget.Latest, true);
  const options = {noLib: true, noEmit: true, strict: true};
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === source.fileName ? source : undefined;
  const program = ts.createProgram([source.fileName], options, host);
  const errors = program.getSemanticDiagnostics(source);
  assert.equal(errors.length, 3);
  assert.ok(errors.every(error => error.code === 2339));
});

test('server-indexed surface capability has one owner and no feature backdoor allowance', () => {
  const route = 'apps/mobile/sources/app/(app)/beeline/backdoor.tsx';
  const store = 'apps/mobile/sources/buzz/second-read-store.ts';
  for (const file of [route, store, 'apps/mobile/sources/sync/transport/second-read-client.ts']) for (const source of [
    "import {mobileSurfaceCache as cache} from '@/buzz/surface-storage'; import {isChatListView as valid} from '@beeline/buzz-client'; cache['write'](address, edited, valid);",
    "sharedLiveConnection().request('readChats', {workspaceId: 'ws'});",
    "monolithPhoneOperation('readTray', {workspaceId: 'ws'});",
    "import {readServerSurface as run} from '@/sync/transport/monolith-operation';",
    "import {applyChatListDelta as reduce} from '@/buzz/chat-list-delta';",
    "const token = {} as ReadAuthority;",
    "function valid(value:unknown):value is ChatListView {return true;} cache.write(address,edited,valid);",
    "cache.write<ChatListView>(address,edited,(value):value is ChatListView=>true);",
    "import {readChatList as run} from '@/buzz/server-read-owner';",
    "const name='readChats'; sharedLiveConnection().request(name,{});",
    "import {sharedLiveConnection as live} from '@/sync/transport/live-connection'; const connection=live(); connection.request(operation,{});",
    "const request=sharedLiveConnection().request; request(operation,{});",
    "const {publish:commit}=cache; commit(address,edited,isChatListView);",
    "const mutate=cache.publish; mutate(address,edited,isChatListView);",
    "import * as reads from '@/sync/transport/monolith-operation'; const run = reads['readServerSurface'];",
    "const {readServerSurface:run}=await import('@/sync/transport/monolith-operation');",
    "export {readServerSurface as run} from '@/sync/transport/monolith-operation';",
    "export * from '@/buzz/chat-list-delta';",
    "export * from '@/buzz/server-read-owner';",
  ]) assert.ok(inspectSource(file, source).errors.some(error => error.includes('server-indexed read authority')), `${file}: ${source}`);
  assert.ok(inspectSource('apps/mobile/sources/sync/transport/monolith-operation.ts',
    'export function executePhoneOperation() {}').errors.some(error => error.includes('module-private')));
  assert.ok(inspectSource('apps/mobile/sources/buzz/server-read-owner.ts',
    'export namespace ChatReads {}').errors.some(error => error.includes('module-private')));
});

test('read owner cannot export another execution handle from inside its allowed file', () => {
  for (const source of [
    'export const backdoor = readAuthority;',
    'export { readAuthority };',
    'export function anotherRead() { return cache.write(address, value, guard); }',
  ]) assert.ok(inspectSource('apps/mobile/sources/buzz/server-read-owner.ts', source).errors.some(error => error.includes('server-indexed read authority')));
});
