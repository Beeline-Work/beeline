import { describe, expect, it, vi } from 'vitest';
import type {
  InstitutionalMemoryProposal,
  InstitutionalMemoryShadowJob,
} from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  InstitutionalMemoryShadowWorker,
  institutionalMemoryShadowEnabled,
} from './institutional-memory-shadow-worker.js';

const job: InstitutionalMemoryShadowJob = {
  id: 'job-1',
  leaseToken: 'lease-1',
  leaseExpiresAt: 1_800_000_000,
  workspaceId: 'workspace-1',
  sourceRoomId: 'room-1',
  sourceMessageId: 'message-1',
  requesterIdentityId: 'human-1',
  directMessage: false,
  messages: [{ id: 'message-1', authorId: 'human-1', createdAt: 1_700_000_000, text: 'Use pnpm.' }],
};

const proposal: InstitutionalMemoryProposal = {
  proposalVersion: 1,
  candidateType: 'correction_candidate',
  memoryKind: 'workspace_fact',
  canonicalKey: 'package-manager',
  body: 'This repository uses pnpm.',
  source: { roomId: 'room-1', messageIds: ['message-1'] },
  audience: 'workspace',
  confidence: 0.9,
  classification: { stillTrueForAnotherRequester: true, rationale: 'Repository fact.' },
  cas: { baseVersion: null },
};

function api(execute: (name: string, input: unknown) => Promise<unknown>): DaemonApiClient {
  return { execute } as unknown as DaemonApiClient;
}

function workerOptions(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    agent: { kind: 'reference' as const, command: '/agent', args: [] },
    agentEnv: {},
    isInteractiveIdle: () => true,
    ...overrides,
  };
}

describe('institutional memory shadow worker', () => {
  it('is dark by default', () => {
    expect(institutionalMemoryShadowEnabled({})).toBe(false);
    expect(
      institutionalMemoryShadowEnabled({ BEELINE_INSTITUTIONAL_MEMORY_SHADOW_ENABLED: 'true' }),
    ).toBe(true);
  });

  it('does not claim while interactive work is active', async () => {
    const execute = vi.fn();
    const worker = new InstitutionalMemoryShadowWorker({
      api: api(execute),
      ...workerOptions({ isInteractiveIdle: () => false }),
    });
    await worker.runOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('claims, extracts and completes without serving a turn', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const execute = vi.fn(async (name: string, input: unknown) => {
      calls.push({ name, input });
      if (name === 'claimInstitutionalMemoryJob') return { enabled: true, job };
      return {};
    });
    const worker = new InstitutionalMemoryShadowWorker({
      api: api(execute),
      ...workerOptions(),
      extract: async () => ({
        proposal,
        usage: {
          inputBytes: 100,
          outputBytes: 50,
          model: 'test',
          extractorVersion: 'test-v1',
        },
      }),
    });
    await worker.runOnce();
    expect(calls.map((call) => call.name)).toEqual([
      'claimInstitutionalMemoryJob',
      'completeInstitutionalMemoryJob',
    ]);
    expect(calls[1]?.input).toMatchObject({
      jobId: 'job-1',
      leaseToken: 'lease-1',
      proposal,
    });
  });

  it('returns a bounded retryable failure to the server', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const execute = vi.fn(async (name: string, input: unknown) => {
      calls.push({ name, input });
      if (name === 'claimInstitutionalMemoryJob') return { enabled: true, job };
      return {};
    });
    const worker = new InstitutionalMemoryShadowWorker({
      api: api(execute),
      ...workerOptions(),
      extract: async () => {
        throw new Error('malformed proposal');
      },
    });
    await worker.runOnce();
    expect(calls.map((call) => call.name)).toEqual([
      'claimInstitutionalMemoryJob',
      'failInstitutionalMemoryJob',
    ]);
    expect(calls[1]?.input).toMatchObject({
      jobId: 'job-1',
      retryable: true,
      error: 'malformed proposal',
    });
  });

  it('aborts an in-flight extraction on daemon shutdown and leaves the lease to expire', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'claimInstitutionalMemoryJob') return { enabled: true, job };
      return {};
    });
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    });
    const worker = new InstitutionalMemoryShadowWorker({
      api: api(execute),
      ...workerOptions(),
      extract: async (_job, signal) => {
        extractionStarted();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        });
        throw new Error('unreachable');
      },
    });
    const run = worker.runOnce();
    await started;
    worker.stop();
    await run;
    expect(calls).toEqual(['claimInstitutionalMemoryJob']);
  });
});
