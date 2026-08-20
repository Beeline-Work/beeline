/**
 * When the daemon is allowed to say its agent is offline.
 *
 * An explicit `offline` marker is authoritative: it beats a same-second
 * heartbeat and no client may contradict it. Its only advantage over simply
 * letting the presence lease expire is speed, and speed is exactly what made it
 * dangerous — it was published after three consecutive reconnect failures,
 * which is roughly SEVEN SECONDS of exponential backoff.
 *
 * The captain's daemon log is full of the shape that trips: pairs of
 * `Room WebSocket failed; reconnecting in 1000ms` minutes apart, each
 * recovering within a second, while the daemon was up and answering the whole
 * time. That is the "X seems offline when it is plainly not" report from the
 * publishing end.
 */
import { describe, expect, it } from 'vitest';
import { PRESENCE_OFFLINE_AFTER_OUTAGE_MS, RoomPollBackoff } from './body.js';
import { AGENT_PRESENCE_STALE_MS } from '@beeline/buzz-client';

/** A backoff whose clock the test drives. */
function backoff(): { it: RoomPollBackoff; advance: (ms: number) => void } {
  let now = 1_000_000;
  const instance = new RoomPollBackoff(1_000, 60_000, PRESENCE_OFFLINE_AFTER_OUTAGE_MS, () => now);
  return {
    it: instance,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('a reconnect blip never asserts the agent offline', () => {
  it('waits out the presence lease rather than pre-empting it with a guess', () => {
    // The lease is what clients already use to decide offline. Waiting it out
    // means the marker can only ever confirm, never guess.
    expect(PRESENCE_OFFLINE_AFTER_OUTAGE_MS).toBe(AGENT_PRESENCE_STALE_MS);
  });

  it('stays quiet through the burst that used to trip it', () => {
    const { it: b, advance } = backoff();
    // Three failures inside a few seconds — the exact shape of the old
    // `failures >= 3` rule, and the exact shape the live log records.
    for (let attempt = 0; attempt < 3; attempt++) {
      b.failed(new Error('Room WebSocket closed'));
      advance(1_000);
      expect(b.shouldMarkPresenceOffline()).toBe(false);
    }
  });

  it('stays quiet across many separate blips that each recover', () => {
    const { it: b, advance } = backoff();
    for (let blip = 0; blip < 20; blip++) {
      b.failed(new Error('Room WebSocket closed'));
      b.failed(new Error('Room WebSocket closed'));
      expect(b.shouldMarkPresenceOffline()).toBe(false);
      // Recovery is what makes each one a blip rather than an outage: the
      // clock that matters restarts.
      expect(b.recovered()).toBe(true);
      advance(5 * 60_000);
    }
    expect(b.shouldMarkPresenceOffline()).toBe(false);
  });

  it('does assert once a single outage genuinely outlives the lease', () => {
    const { it: b, advance } = backoff();
    b.failed(new Error('Room WebSocket closed'));
    advance(PRESENCE_OFFLINE_AFTER_OUTAGE_MS - 1);
    b.failed(new Error('Room WebSocket closed'));
    expect(b.shouldMarkPresenceOffline()).toBe(false);
    advance(2);
    b.failed(new Error('Room WebSocket closed'));
    expect(b.shouldMarkPresenceOffline()).toBe(true);
  });

  it('says it once per outage, not once per retry', () => {
    const { it: b, advance } = backoff();
    b.failed(new Error('down'));
    advance(PRESENCE_OFFLINE_AFTER_OUTAGE_MS + 1);
    expect(b.shouldMarkPresenceOffline()).toBe(true);
    for (let retry = 0; retry < 10; retry++) {
      b.failed(new Error('down'));
      advance(60_000);
      // The marker is a statement, not a heartbeat. Republishing it every
      // retry spends the quota the real heartbeat needs.
      expect(b.shouldMarkPresenceOffline()).toBe(false);
    }
  });

  it('re-arms after a recovery, so a later real outage is still reported', () => {
    const { it: b, advance } = backoff();
    b.failed(new Error('down'));
    advance(PRESENCE_OFFLINE_AFTER_OUTAGE_MS + 1);
    expect(b.shouldMarkPresenceOffline()).toBe(true);
    b.recovered();

    b.failed(new Error('down again'));
    expect(b.shouldMarkPresenceOffline()).toBe(false);
    advance(PRESENCE_OFFLINE_AFTER_OUTAGE_MS + 1);
    b.failed(new Error('down again'));
    expect(b.shouldMarkPresenceOffline()).toBe(true);
  });

  it('still spaces retries exponentially and still honours an advertised delay', () => {
    const { it: b } = backoff();
    expect(b.failed()).toBe(1_000);
    expect(b.failed()).toBe(2_000);
    expect(b.failed()).toBe(4_000);
    // A relay that names its own delay always wins over the local schedule.
    expect(
      b.failed(new Error('publishEvent failed: HTTP 429 rate-limited: retry in 30s')),
    ).toBeGreaterThanOrEqual(30_000);
  });
});
