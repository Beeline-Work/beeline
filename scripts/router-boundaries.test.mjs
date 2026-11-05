import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource, scanRouterTree } from './router-boundaries.mjs';

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
    `channel.operationReady()`,
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
    waitForConnection() { return this.channel.operationReady(); }
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
