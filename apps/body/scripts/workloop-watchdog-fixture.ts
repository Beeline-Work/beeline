/** Isolated systemd acceptance fixture: no production token, socket or agent. */
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { ThinDaemonCore } from '../src/thin-core.js';
import { SystemdNotifier, startLocalWatchdog } from '../src/systemd.js';
import { identityFromKey, type AgentRuntimeRecord } from '../src/runtime.js';
import type { DaemonApiClient } from '../src/daemon-api-client.js';

const state = process.argv[2]!;
const root = dirname(state);
const generation = Number(await readFile(state, 'utf8').catch(() => '0')) + 1;
await writeFile(state, String(generation));
const liveSocket = createServer();
await new Promise<void>(ready => liveSocket.listen(0, '127.0.0.1', ready));
const agent = identityFromKey('11'.repeat(32), 'Fixture');
const api = { execute: async () => ({ workspaceIds: ['fixture'], rooms: [] }) } as unknown as DaemonApiClient;
const core = new ThinDaemonCore({
  agent: { name: 'Fixture', publicKey: agent.publicKey, secretKeyHex: '11'.repeat(32) },
  rooms: [], communityId: 'fixture', supervisorRoot: root,
  transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1', daemonToken: 'fixture' },
} as unknown as AgentRuntimeRecord, resolve(root, 'runtime.json'), { workspaceRoot: root } as never, { daemonApi: api });
const notifier = new SystemdNotifier();
process.env.BEELINE_MANAGED_BY_SYSTEMD = '1';
let established = false;
startLocalWatchdog(notifier, () => 'fixture loop healthy', () => core.requestWorkLoopProgress(), 200);
await core.run({ onProgress: async () => {
  if (!established) {
    established = true;
    await notifier.ready('fixture ready');
  } else if (generation === 1) {
    // An awaited operation freezes the work loop, while the event loop and
    // the existing local watchdog timer continue to execute normally.
    await new Promise<void>(() => undefined);
  }
} });
