import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiClient, type DaemonWebSocketFactory } from './daemon-api-client.js';
import { ForceUpdateCoordinator } from './force-update.js';
import { reportInterruptedTurns } from './force-update-journal.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class Socket {
  static readonly OPEN = 1;
  readyState = Socket.OPEN;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  on(): void {}
  send(): void {}
  close(): void { this.onclose?.(); }
  push(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe('server-enforced helper handoff', () => {
  for (const signal of ['push', 'refusal'] as const) {
    it(`interrupts, installs, restarts, reports and resumes after a ${signal}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'beeline-force-update-'));
      roots.push(root);
      const events: string[] = [];
      const turn = { roomId: 'room', requestId: 'request', generationId: 'old-generation' };
      const install = vi.fn(async () => { events.push('install'); return 'release-v0.0.70'; });
      const restart = vi.fn(async () => { events.push('restart'); });
      const coordinator = new ForceUpdateCoordinator({
        loadedVersion: 'v0.0.69', runtimeDir: root,
        interrupt: () => { events.push('interrupt'); return [turn]; },
        install, restart, failed: (error) => { throw error; },
      });
      const socket = new Socket();
      const api = new DaemonApiClient('http://localhost:3000', 'token', 'agent',
        vi.fn(async () => signal === 'refusal'
          ? Response.json({ error: 'update_required', minVersion: 'v0.0.70' }, { status: 426 })
          : Response.json({ commandProtocol: 1, commands: [] })),
        (() => socket as never) as DaemonWebSocketFactory);
      api.setHelperIdentity({ releaseVersion: 'v0.0.69' });
      api.setForceUpdateListener((minVersion) => coordinator.request(minVersion));
      if (signal === 'push') {
        api.liveSubscribe('room');
        socket.push({ type: 'force-update', minVersion: 'v0.0.70' });
      } else {
        await expect(api.execute('getAgentCommands', { roomId: 'room' }))
          .rejects.toMatchObject({ status: 426 });
      }
      await coordinator.pending;
      const resumedCommand = {
        id: 'same-command', roomId: turn.roomId, agentId: 'agent',
        sourceMessageId: turn.requestId, turnRequestId: turn.requestId,
        rootCommandId: 'same-command', rootSourceMessageId: turn.requestId,
        agentDepth: 0, action: 'input', reason: 'human_tag',
        source: { id: turn.requestId, authorId: 'human', body: 'Continue the request',
          createdAt: 1, type: 'message', attachments: [] },
      };
      let requeued = false;
      const successorApi = {
        execute: vi.fn(async (name: string, input: Record<string, unknown>) => {
          if (name === 'postAgentTurnReceipt') {
            expect(input).toMatchObject({ ...turn, reasonKind: 'update-interrupted' });
            events.push('receipt');
            requeued = true;
            return { updateRequeued: true };
          }
          if (name === 'getAgentCommands')
            return { commandProtocol: 1, commands: requeued ? [resumedCommand] : [] };
          return { id: 'ok' };
        }),
        liveSubscribe: () => () => undefined,
      };
      await reportInterruptedTurns(root, successorApi as never, 'agent');
      const abort = new AbortController();
      await runServerCommandIntake({ api: successorApi as never, roomId: 'room', agentId: 'agent',
        context: new CommandExecutionContext(root), signal: abort.signal,
        run: async () => { events.push('resume'); setTimeout(() => abort.abort(), 0); },
        stop: () => undefined });
      expect(events).toEqual(['interrupt', 'install', 'restart', 'receipt', 'resume']);
      expect(install).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledWith('release-v0.0.70');
    });
  }
});
