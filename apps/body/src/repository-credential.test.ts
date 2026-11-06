import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, writeRuntimeRecord } from './runtime.js';

const exec = promisify(execFile);

it('corner-read-token exits without replacing the helper registration or cancelling its active turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'credential-owner-'));
  const identity = identityFromKey('01'.repeat(32), 'fixture');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    expect(request.headers.authorization).toBe(`Bearer bdt_${'a'.repeat(43)}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ token: 'fixture-repository-token', expiresAt: Date.now() + 60_000 }));
  });
  const sockets = new WebSocketServer({ server });
  let registrations = 0;
  let owner: import('ws').WebSocket | undefined;
  sockets.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'register-machine') {
      registrations++;
      if (registrations > 2) return;
      if (owner && owner !== socket) owner.send(JSON.stringify({ type: 'unregistered', agentId: identity.publicKey, reason: 'replaced' }));
      owner = socket;
      socket.send(JSON.stringify({type:'registered-machine',agents:[{type:'registered',agentId:identity.publicKey,
        capabilities:{daemonOperationsV1:true,turnOwnershipV1:true,turnConnectionId:'parent',turnConnectionEpoch:1}}]}));
    }
    if (frame.type === 'daemon-operation') socket.send(JSON.stringify({ type: 'daemon-operation-result',
      agentId: identity.publicKey, requestId: frame.requestId, result: { token: 'fixture-repository-token', expiresAt: Date.now() + 60_000 } }));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = new DaemonApiClient(baseUrl, `bdt_${'a'.repeat(43)}`, identity.publicKey);
  try {
    const configPath = await writeRuntimeRecord({ version: 2, supervisorRoot: root, communityId: 'fixture', pairedBy: 'fixture',
      agent: { name: 'fixture', secretKeyHex: '01'.repeat(32), publicKey: identity.publicKey },
      body: { name: 'fixture', secretKeyHex: '01'.repeat(32), publicKey: identity.publicKey }, rooms: [],
      agentBinary: 'unused', mcpBinary: 'unused', transport: { kind: 'monolith', baseUrl, daemonToken: `bdt_${'a'.repeat(43)}` } });
    await api.execute('getRoomGitHubToken', { roomId: 'fixture-room' });
    const cancelled = vi.fn();
    api.noteOwnedTurnClaim({ roomId: 'fixture-room', requestId: 'active', generationId: 'generation' },
      api.turnOwnershipScope()!, cancelled);
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'corner-read-token',
      '--config', configPath, '--room', 'fixture-room'], { timeout: 10_000, env: { ...process.env, BEELINE_SENTRY_DSN: '' } })
      .then(result => ({ ...result, exited: true }), error => ({ stdout: error.stdout, stderr: error.stderr, exited: false }));
    expect(result.stdout.trim()).toBe('fixture-repository-token');
    expect({ exited: result.exited, registrations, cancellations: cancelled.mock.calls.length, requests })
      .toEqual({ exited: true, registrations: 1, cancellations: 0, requests: ['/v1/daemon/operations/getRoomGitHubToken'] });
    expect(api.turnOwnershipScope()).toEqual({ connectionId: 'parent', epoch: 1 });
  } finally {
    api.closeLive();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
