import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, SqlDatabase } from './database.js';
import { DaemonService, CORNER_WAKE_TIMEOUT_MS } from './daemon-service.js';
import { LiveHub } from './live.js';

const AGENT_ID = '11'.repeat(32);
const CORNER_ID = 'corner-id';

/** A member of `CORNER_ID`; every other query answers empty. */
function memberDatabase(): SqlDatabase {
  return {
    async query<Row>(sql: string): Promise<QueryResult<Row>> {
      if (sql.includes('FROM memberships')) {
        return { rows: [{}] as Row[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
      return work(this);
    },
  };
}

describe('corner wake (waitForCornerWake)', () => {
  it('resolves as soon as the corner has a live event, not after the timeout', async () => {
    const live = new LiveHub();
    const daemon = new DaemonService(memberDatabase(), live);

    const started = Date.now();
    const pending = daemon.execute('waitForCornerWake', { cornerId: CORNER_ID }, AGENT_ID);
    // Give the subscription a tick to attach before publishing.
    await new Promise((resolve) => setTimeout(resolve, 5));
    live.publish({ type: 'invalidate', roomId: CORNER_ID, reason: 'message' });

    const result = await pending;
    expect(result).toEqual({ woken: true });
    expect(Date.now() - started).toBeLessThan(CORNER_WAKE_TIMEOUT_MS);
  });

  it('wakes on a check-fact event and on a grant-decision (human) event, not just messages', async () => {
    const live = new LiveHub();
    const daemon = new DaemonService(memberDatabase(), live);

    for (const reason of ['github', 'grant', 'corner'] as const) {
      const pending = daemon.execute('waitForCornerWake', { cornerId: CORNER_ID }, AGENT_ID);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live.publish({ type: 'invalidate', roomId: CORNER_ID, reason });
      await expect(pending).resolves.toEqual({ woken: true });
    }
  });

  it('never wakes on another room/corner\'s event', async () => {
    vi.useFakeTimers();
    try {
      const live = new LiveHub();
      const daemon = new DaemonService(memberDatabase(), live);
      const pending = daemon.execute('waitForCornerWake', { cornerId: CORNER_ID }, AGENT_ID);
      live.publish({ type: 'invalidate', roomId: 'a-different-corner', reason: 'message' });
      const settleCheck = vi.fn();
      pending.then(settleCheck);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settleCheck).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CORNER_WAKE_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ woken: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves false on a bounded timeout when nothing arrives — the daemon poll remains the recovery path', async () => {
    vi.useFakeTimers();
    try {
      const live = new LiveHub();
      const daemon = new DaemonService(memberDatabase(), live);
      const pending = daemon.execute('waitForCornerWake', { cornerId: CORNER_ID }, AGENT_ID);
      await vi.advanceTimersByTimeAsync(CORNER_WAKE_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ woken: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a wake request for a corner the caller does not belong to (owner/member scope)', async () => {
    const live = new LiveHub();
    const database: SqlDatabase = {
      async query<Row>(): Promise<QueryResult<Row>> {
        return { rows: [], rowCount: 0 };
      },
      async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
        return work(this);
      },
    };
    const daemon = new DaemonService(database, live);
    await expect(
      daemon.execute('waitForCornerWake', { cornerId: CORNER_ID }, AGENT_ID),
    ).rejects.toThrow('daemon room access denied');
  });
});
