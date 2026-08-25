import { randomUUID } from 'node:crypto';
import { signEvent } from '@beeline/nostr';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDelegationTurn,
  createIdentity,
  defaultDelegationBudget,
  KIND_STREAM_MESSAGE,
  type DelegationTurnV1,
} from '@beeline/buzz-client';
import {
  DelegationRuntime,
  type DelegationRuntimeDependencies,
} from './delegation-runtime.js';

const NOW = 1_900_000_000;

function fixture(overrides: Partial<DelegationRuntimeDependencies['reader']> = {}) {
  const sender = createIdentity();
  const recipient = createIdentity();
  const principal = createIdentity();
  const value: DelegationTurnV1 = {
    version: 1,
    delegationId: randomUUID(),
    workItemId: randomUUID(),
    phase: 'assign',
    roomId: randomUUID(),
    workspaceId: 'workspace-one',
    fromAgentPubkey: sender.publicKey,
    toAgentPubkey: recipient.publicKey,
    rootEventId: '1'.repeat(64),
    parentEventId: '2'.repeat(64),
    principalPubkey: principal.publicKey,
    path: [sender.publicKey],
    depth: 1,
    budget: defaultDelegationBudget(NOW, 100),
    task: 'Research ten verified candidates.',
    createdAt: NOW,
  };
  const event = buildDelegationTurn(sender, value);
  const claimed = new Set<string>();
  const published: typeof event[] = [];
  const reader: DelegationRuntimeDependencies['reader'] = {
    isRegisteredAgent: async (pubkey) => pubkey === sender.publicKey,
    isRoomMember: async () => true,
    isWorkspaceMember: async () => true,
    accessPermitted: async () => true,
    targetOnline: async () => true,
    targetSupportsDelegationV1: async () => true,
    graph: async () => ({ turns: [], receipts: [] }),
    delegatedUsage: async () => ({ calls: 0, reservedTokens: 0 }),
    ...overrides,
  };
  const runtime = new DelegationRuntime({
    identity: recipient,
    reader,
    now: () => NOW + 1,
    dailyLimit: { maxCalls: 20, maxReservedTokens: 20_000 },
    claimInbound: async (id) => {
      if (claimed.has(id)) return 'duplicate';
      claimed.add(id);
      return 'claimed';
    },
    reserveOutbound: async () => 'claimed',
    publish: async (receipt) => {
      published.push(receipt);
    },
  });
  return { claimed, event, principal, published, recipient, runtime, sender, value };
}

describe('DelegationRuntime', () => {
  it('turns concurrent WS and HTTP delivery into exactly one real target turn', async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => held);
    const first = f.runtime.handleEvent(f.event, invoke);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await expect(f.runtime.handleEvent(f.event, invoke)).resolves.toEqual({ status: 'duplicate' });
    release();
    await expect(first).resolves.toMatchObject({ status: 'complete' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(f.published.map((event) => JSON.parse(event.content).status)).toEqual([
      'working',
      'complete',
    ]);
  });

  it('keeps ordinary agent-authored Room messages context-only', async () => {
    const f = fixture();
    const ordinary = signEvent(
      {
        pubkey: f.sender.publicKey,
        created_at: NOW,
        kind: KIND_STREAM_MESSAGE,
        tags: [['h', f.value.roomId]],
        content: '@Scout: this prose alone is not authority',
      },
      f.sender.secretKey,
    );
    const invoke = vi.fn(async () => undefined);
    await expect(f.runtime.handleEvent(ordinary, invoke)).resolves.toEqual({ status: 'ignored' });
    expect(invoke).not.toHaveBeenCalled();
    expect(f.published).toHaveLength(0);
  });

  it('publishes one failed receipt and never auto-retries a failed model invocation', async () => {
    const f = fixture();
    const invoke = vi.fn(async () => {
      throw new Error('ACP exited');
    });
    await expect(f.runtime.handleEvent(f.event, invoke)).resolves.toMatchObject({ status: 'failed' });
    await expect(f.runtime.handleEvent(f.event, invoke)).resolves.toEqual({ status: 'duplicate' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(f.published.map((event) => JSON.parse(event.content).status)).toEqual([
      'working',
      'failed',
    ]);
  });

  it('fails closed on access, circuit-breaker, and authority boundaries', async () => {
    const denied = fixture({ accessPermitted: async () => false });
    const invoke = vi.fn(async () => undefined);
    await expect(denied.runtime.handleEvent(denied.event, invoke)).resolves.toMatchObject({
      status: 'refused',
      reason: 'access-denied',
    });

    const exhausted = fixture({
      delegatedUsage: async () => ({ calls: 20, reservedTokens: 0 }),
    });
    await expect(exhausted.runtime.handleEvent(exhausted.event, invoke)).resolves.toMatchObject({
      status: 'refused',
      reason: 'over-turn-budget',
    });

    const unavailable = fixture({
      isWorkspaceMember: async () => {
        throw new Error('relay unavailable');
      },
    });
    await expect(unavailable.runtime.handleEvent(unavailable.event, invoke)).resolves.toEqual({
      status: 'deferred',
      reason: 'authority-unavailable',
    });
    expect(unavailable.claimed.size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });
});
