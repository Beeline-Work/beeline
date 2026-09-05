import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, SqlDatabase } from './database.js';
import {
  DaemonService,
  DAEMON_OPERATION_NAMES,
  CORNER_WAKE_TIMEOUT_MS,
} from './daemon-service.js';
import { CORNER_WAKE_MIN_INTERVAL_MS } from './corner-wake.js';
import { LiveHub, type LiveEvent } from './live.js';

const AGENT_ID = '11'.repeat(32);
const OTHER_AGENT_ID = '22'.repeat(32);
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

describe("corner wake ignores the corner's own turn narration", () => {
  const ownNarration = [
    { type: 'draft', roomId: CORNER_ID, agentId: AGENT_ID, turnId: 't', text: 'thinking' },
    { type: 'thought', roomId: CORNER_ID, agentId: AGENT_ID, turnId: 't', text: 'thinking' },
    { type: 'retract', roomId: CORNER_ID, agentId: AGENT_ID, turnId: 't', kind: 'draft' },
    { type: 'presence', roomId: CORNER_ID, agentId: AGENT_ID, status: 'online', observedAt: 1 },
    { type: 'invalidate', roomId: CORNER_ID, reason: 'activity', agentId: AGENT_ID },
    { type: 'invalidate', roomId: CORNER_ID, reason: 'turn', agentId: AGENT_ID },
  ] as const satisfies readonly LiveEvent[];

  for (const event of ownNarration) {
    const label = event.type === 'invalidate' ? `invalidate/${event.reason}` : event.type;
    it(`does not wake on its own ${label} — the loop can act on none of it`, async () => {
      vi.useFakeTimers();
      try {
        const live = new LiveHub();
        const daemon = new DaemonService(memberDatabase(), live);
        const pending = daemon.execute('waitForCornerWake', { cornerId: CORNER_ID }, AGENT_ID);
        const settleCheck = vi.fn();
        void pending.then(settleCheck);
        await vi.advanceTimersByTimeAsync(0);
        // A whole streaming turn's worth of the same delta.
        for (let index = 0; index < 50; index += 1) live.publish(event);
        await vi.advanceTimersByTimeAsync(CORNER_WAKE_TIMEOUT_MS - 1);
        expect(settleCheck).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ woken: false });
      } finally {
        vi.useRealTimers();
      }
    });
  }

  const external = [
    // A human message and a phone-written close request: server facts, no author.
    { type: 'invalidate', roomId: CORNER_ID, reason: 'message' },
    { type: 'invalidate', roomId: CORNER_ID, reason: 'phone-write' },
    // The server's GitHub check fact.
    { type: 'invalidate', roomId: CORNER_ID, reason: 'github' },
    // Another agent narrating in this corner is still news to this one.
    { type: 'draft', roomId: CORNER_ID, agentId: OTHER_AGENT_ID, turnId: 't', text: 'hi' },
    { type: 'invalidate', roomId: CORNER_ID, reason: 'activity', agentId: OTHER_AGENT_ID },
  ] as const satisfies readonly LiveEvent[];

  for (const event of external) {
    const label = event.type === 'invalidate' ? `invalidate/${event.reason}` : event.type;
    it(`wakes on ${label} authored by someone else`, async () => {
      const live = new LiveHub();
      const daemon = new DaemonService(memberDatabase(), live);
      const pending = daemon.execute('waitForCornerWake', { cornerId: CORNER_ID }, AGENT_ID);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live.publish(event);
      await expect(pending).resolves.toEqual({ woken: true });
    });
  }

  it('holds a burst of 50 qualifying events to a handful of intake iterations', async () => {
    vi.useFakeTimers();
    try {
      const live = new LiveHub();
      const daemon = new DaemonService(memberDatabase(), live);
      let wakes = 0;
      let stop = false;
      // The corner's intake loop: poll, then immediately wait again.
      const loop = (async () => {
        while (!stop) {
          const result = (await daemon.execute(
            'waitForCornerWake',
            { cornerId: CORNER_ID },
            AGENT_ID,
          )) as { woken: boolean };
          if (!result.woken) return;
          wakes += 1;
        }
      })();
      await vi.advanceTimersByTimeAsync(0);
      // Fifty external events across one second of wall clock.
      for (let index = 0; index < 50; index += 1) {
        live.publish({ type: 'invalidate', roomId: CORNER_ID, reason: 'message' });
        await vi.advanceTimersByTimeAsync(20);
      }
      // One second of burst against a 400ms floor is three wakes, plus at most
      // one for the burst's leading edge. Without the floor it is fifty.
      expect(wakes).toBeGreaterThan(0);
      expect(wakes).toBeLessThanOrEqual(4);
      expect(CORNER_WAKE_MIN_INTERVAL_MS).toBe(400);
      // Let the loop's last outstanding long-poll time out, then settle.
      stop = true;
      await vi.advanceTimersByTimeAsync(CORNER_WAKE_TIMEOUT_MS * 2);
      await loop;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the wake is reachable over the daemon route', () => {
  it('routes waitForCornerWake — an unrouted long-poll 404s instantly and spins the loop', () => {
    // The route gate is `DAEMON_OPERATION_NAMES`; #912 added the operation and
    // its handler but not this entry, so every wake answered 404
    // `unknown_daemon_operation` and the loop's sleep-vs-wake race collapsed
    // into one poll per network round-trip.
    expect(DAEMON_OPERATION_NAMES.has('waitForCornerWake')).toBe(true);
  });
});
