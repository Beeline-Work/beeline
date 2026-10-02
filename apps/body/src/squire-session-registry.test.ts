import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SQUIRE_ORDER_LOCK_TTL_MS,
  SquireSessionRegistry,
  processAlive,
  squireOrderIdentity,
  type SquireSessionRecord,
} from './squire-session-registry.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function registryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'squire-registry-'));
  dirs.push(dir);
  return dir;
}

function session(overrides: Partial<SquireSessionRecord> = {}): SquireSessionRecord {
  return {
    sessionId: 'browser-1',
    ownerAgentId: 'agent-a',
    ownerId: 'owner-1',
    conversationId: 'room-a',
    relayId: 'relay-a',
    pid: process.pid,
    startedAt: Date.now(),
    turnLive: true,
    approvalPending: false,
    updatedAt: Date.now(),
    closeUrl: 'http://127.0.0.1:1',
    closeToken: 'token-a',
    ...overrides,
  };
}

describe('squire order identity', () => {
  it('normalizes case and whitespace so two agents describe the same order identically', () => {
    const first = squireOrderIdentity('inject_card', {
      merchant: '  Acme  Store ', amount_cents: 1299, currency: 'usd', item: 'Widget',
    });
    const second = squireOrderIdentity('inject_card', {
      merchant: 'acme store', amount_cents: 1299, currency: 'USD', item: 'widget ',
    });
    expect(first?.orderKey).toBe(second?.orderKey);
    expect(first?.label).toContain('acme store');
  });

  it('ignores calls that cannot release a card', () => {
    expect(squireOrderIdentity('operate_observe', { merchant: 'Acme', amount_cents: 1, currency: 'USD' }))
      .toBeUndefined();
    expect(squireOrderIdentity('operate_drive', { goal: 'buy', facts: { merchant: 'Acme', amount_cents: 1, currency: 'USD' } }))
      .toBeUndefined();
    expect(squireOrderIdentity('inject_card', { sessionId: 'browser-1' })).toBeUndefined();
  });

  it('reads an operate_drive order from its facts once a card_ref is present', () => {
    const identity = squireOrderIdentity('operate_drive', {
      goal: 'complete checkout',
      facts: { card_ref: 'card-1', merchant: 'Acme', amount_cents: 500, currency: 'USD' },
    });
    expect(identity?.orderKey).toBe('acme|500|USD');
  });
});

describe('squire session registry', () => {
  it('derives liveness from the owning process, not the record', async () => {
    const dir = await registryDir();
    const registry = new SquireSessionRegistry(dir);
    registry.registerSession(session());
    expect(registry.listSessions()[0]).toMatchObject({ turnLive: true, ownerAlive: true, stale: false });

    registry.registerSession(session({ sessionId: 'browser-2', pid: 999_999_999, turnLive: true }));
    const dead = registry.listSessions().find((entry) => entry.sessionId === 'browser-2')!;
    expect(dead).toMatchObject({ ownerAlive: false, turnLive: false, stale: true });
    expect(processAlive(999_999_999)).toBe(false);
  });

  it('refuses a live holder and takes over a dead one', async () => {
    const dir = await registryDir();
    const registry = new SquireSessionRegistry(dir);
    const lock = {
      orderKey: 'acme|1299|USD', label: 'widget', holderAgentId: 'agent-a', holderOwnerId: 'owner-1',
      conversationId: 'room-a', relayId: 'relay-a', pid: process.pid, acquiredAt: Date.now(),
      approvalPending: true,
    };
    expect(registry.acquireOrderLock(lock).acquired).toBe(true);
    const refused = registry.acquireOrderLock({ ...lock, relayId: 'relay-b' });
    expect(refused.acquired).toBe(false);
    if (!refused.acquired) expect(refused.heldBy.holderAgentId).toBe('agent-a');

    // A crashed holder's lock is stolen rather than wedging the order forever.
    await rm(join(dir, 'orders'), { recursive: true, force: true });
    expect(registry.acquireOrderLock({ ...lock, pid: 999_999_999 }).acquired).toBe(true);
    const stolen = registry.acquireOrderLock({ ...lock, relayId: 'relay-b' });
    expect(stolen.acquired).toBe(true);

    // An expired lock is taken over too.
    await rm(join(dir, 'orders'), { recursive: true, force: true });
    expect(registry.acquireOrderLock({
      ...lock, acquiredAt: Date.now() - SQUIRE_ORDER_LOCK_TTL_MS - 1,
    }).acquired).toBe(true);
    expect(registry.acquireOrderLock({ ...lock, relayId: 'relay-b' }).acquired).toBe(true);
  });

  it('never releases another relay\'s lock', async () => {
    const dir = await registryDir();
    const registry = new SquireSessionRegistry(dir);
    const lock = {
      orderKey: 'acme|1299|USD', label: 'widget', holderAgentId: 'agent-a', holderOwnerId: 'owner-1',
      conversationId: 'room-a', relayId: 'relay-a', pid: process.pid, acquiredAt: Date.now(),
      approvalPending: false,
    };
    expect(registry.acquireOrderLock(lock).acquired).toBe(true);
    registry.releaseOrderLock(lock.orderKey, 'relay-b');
    expect(registry.listOrderLocks()).toHaveLength(1);
    registry.releaseOrderLock(lock.orderKey, 'relay-a');
    expect(registry.listOrderLocks()).toHaveLength(0);
  });
});
