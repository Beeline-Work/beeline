import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { TokenAuth } from '../../server/src/auth.js';
import type { ConnectionPresence } from '../../server/src/connection-presence.js';
import type { DaemonService } from '../../server/src/daemon-service.js';
import type { SqlDatabase } from '../../server/src/database.js';
import { LiveHub } from '../../server/src/live.js';
import type { PhoneService } from '../../server/src/phone-service.js';
import { createBeelineServer } from '../../server/src/server.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';

it.each(['registration', 'subscription', 'commands', 'inbox'] as const)(
  'recovers stalled %s with transport pings still flowing, then claims queued work without polling', async stage => {
    const agentId = 'a'.repeat(64);
    const roomId = 'room';
    const live = new LiveHub();
    const root = await mkdtemp(join(process.cwd(), '.intake-link-test-'));
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    let stall = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reached = vi.fn();
    const maybeStall = async (at: typeof stage) => {
      if (stall && stage === at) { stall = false; reached(); await blocked; }
    };
    let commands: AgentCommand[] = [];
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') {
        await maybeStall('commands');
        return { commandProtocol: 1, commands };
      }
      await maybeStall('inbox');
      return { items: [] };
    });
    const query = vi.fn();
    const claimConnection = vi.fn(async () => 1);
    const releaseConnection = vi.fn(async () => undefined);
    const server = createBeelineServer({
      database: { query, transaction: vi.fn() } as unknown as SqlDatabase,
      auth: { authenticateDaemon: async () => { await maybeStall('registration'); return agentId; } } as unknown as TokenAuth,
      phone: { canReadRooms: async (ids: string[]) => { await maybeStall('subscription'); return new Set(ids); } } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      connectionPresence: { claimConnection, releaseConnection, announce: async () => undefined } as unknown as ConnectionPresence,
      live, mediaMaximumBytes: 1, liveHeartbeatMs: 30,
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const requests: string[] = [];
    const sockets: WebSocket[] = [];
    let pings = 0;
    const client = new DaemonApiClient(`http://127.0.0.1:${port}`, 'bdt_fixture', agentId,
      (async (url: string) => {
        const name = url.split('/').at(-1)!;
        requests.push(name);
        if (name === 'getAgentCommands') return Response.json({ commandProtocol: 1, commands });
        if (name === 'claimAgentCommand') return Response.json({ id: commands[0]!.id });
        throw new Error(`unexpected HTTP read ${name}`);
      }) as typeof fetch,
      (url, protocols, options) => {
        const socket = new WebSocket(url, protocols, options);
        socket.on('ping', () => pings++);
        sockets.push(socket);
        return socket;
      }, undefined, {
        heartbeatTimeoutMs: 240, stableSocketMs: 30, stableCloseJitterMs: 1,
        backoffBaseMs: 1, backoffMaxMs: 1,
      });
    const abort = new AbortController();
    const run = vi.fn(async (_command: AgentCommand) => { commands = []; });
    const states: boolean[] = [];
    const intake = runServerCommandIntake({
      api: client, roomId, agentId, context: new CommandExecutionContext(root),
      signal: abort.signal, run, stop: vi.fn(), onSubscriptionState: value => states.push(value),
    });
    try {
      await vi.waitFor(() => expect(states).toContain(true));
      // Healthy application checkpoints must perform no reads, even when idle.
      const reads = execute.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(sockets).toHaveLength(1);
      expect(requests).toEqual(['getAgentCommands']);
      expect(execute).toHaveBeenCalledTimes(reads);
      expect(query).not.toHaveBeenCalled();
      stall = true;
      if (stage === 'registration' || stage === 'subscription') client.machine.reconnectNow();
      else live.publish({ type: 'invalidate', roomId,
        reason: stage === 'commands' ? 'postgres:agent_commands' : 'postgres:messages', targetAgentId: agentId });
      await vi.waitFor(() => expect(reached).toHaveBeenCalled());
      const attempts = sockets.length;
      const pingsBefore = pings;
      const stalledAt = Date.now();
      commands = [{
        id: 'queued', roomId, agentId, sourceMessageId: 'queued', turnRequestId: 'queued',
        rootCommandId: 'queued', rootSourceMessageId: 'queued', agentDepth: 0,
        action: 'input', reason: 'human_tag',
        source: { id: 'queued', authorId: 'human', body: 'Hello', createdAt: 1, type: 'message', attachments: [] },
      }];
      // Leave the old await blocked. Only a new application session can serve.
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(attempts), { timeout: 1_500 });
      expect(Date.now() - stalledAt).toBeLessThan(1_000);
      expect(pings).toBeGreaterThan(pingsBefore + 2);
      expect(warn).toHaveBeenCalled();
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 1_500 });
      expect(run.mock.calls[0]![0].id).toBe('queued');
      expect(requests).toContain('claimAgentCommand');
      expect(claimConnection.mock.calls.length).toBeGreaterThan(1);
      expect(releaseConnection).toHaveBeenCalled();
      unblock(); // A late result on the obsolete session must not redeliver.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(run).toHaveBeenCalledOnce();
    } finally {
      stall = false; unblock(); abort.abort(); await intake;
      client.machine.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      warn.mockRestore();
    }
  },
);
