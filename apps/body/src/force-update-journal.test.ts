import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { DaemonApiError } from './daemon-api-client.js';
import { journalInterruptedTurns, reportInterruptedTurns } from './force-update-journal.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('forced update interruption handoff', () => {
  it('reports each interrupted turn exactly once and retains failed replays for the next successor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-force-journal-'));
    roots.push(root);
    const turns = [
      { roomId: 'room', requestId: 'one', generationId: 'old-generation' },
      { roomId: 'corner', requestId: 'two', generationId: 'old-generation' },
    ];
    journalInterruptedTurns(root, turns);
    journalInterruptedTurns(root, turns);
    const execute = vi.fn()
      .mockResolvedValueOnce({ updateRequeued: true })
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce({ updateRequeued: true });
    const api = { execute } as unknown as DaemonApiClient;
    await expect(reportInterruptedTurns(root, api, 'agent')).rejects.toThrow('network failed');
    await reportInterruptedTurns(root, api, 'agent');
    await reportInterruptedTurns(root, api, 'agent');
    expect(execute.mock.calls.map(([name, input]) => [name, input])).toEqual([
      ['postAgentTurnReceipt', { agentId: 'agent', ...turns[0], status: 'failed',
        reason: 'interrupted by update', reasonKind: 'update-interrupted' }],
      ['postAgentTurnReceipt', { agentId: 'agent', ...turns[1], status: 'failed',
        reason: 'interrupted by update', reasonKind: 'update-interrupted' }],
      ['postAgentTurnReceipt', { agentId: 'agent', ...turns[1], status: 'failed',
        reason: 'interrupted by update', reasonKind: 'update-interrupted' }],
    ]);
  });

  it('reports after the old generation lease was reopened during a long install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-force-journal-'));
    roots.push(root);
    journalInterruptedTurns(root, [{ roomId: 'room', requestId: 'one', generationId: 'old' }]);
    const execute = vi.fn()
      .mockRejectedValueOnce(new DaemonApiError('stale', 403, false,
        'command output authority rejected'))
      .mockResolvedValueOnce({ updateRequeued: true });
    await reportInterruptedTurns(root, { execute } as unknown as DaemonApiClient, 'agent');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).not.toHaveProperty('generationId');
  });
});
