import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newIdentity, type Identity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';

const mocks = vi.hoisted(() => ({
  publishEvent: vi.fn(),
}));

vi.mock('@beeline/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/gate')>();
  return { ...actual, publishEvent: mocks.publishEvent };
});

import { Body } from './body.js';
import { CornerStatePublisher, signCornerStateRecord } from './corner-state.js';

const config = {
  agentBinary: '/nonexistent',
  mcpBinary: '/nonexistent',
  agentEnv: {},
  workspaceRoot: '/tmp/buzzy-corner-state-unit',
  relayBaseUrl: 'http://relay.test',
  relayHost: 'relay.test',
  relayScheme: 'http',
  relayWsUrl: 'ws://relay.test',
  autoApprovePermissions: true,
};

/** A SubchannelInfo-shaped object carrying exactly what the state funnel
 * reads. Cast through `unknown` so tests need no live session. */
function minimalInfo(cornerId: string) {
  return {
    subchannelId: cornerId,
    worktreePath: '/tmp/nowhere',
    featureBranch: 'feature/test',
    role: newIdentity('agent'),
    session: { parentChannelId: 'room-1' },
    lastPolledAt: 0,
    archived: false,
  } as unknown as {
    subchannelId: string;
    worktreePath: string;
    featureBranch: string;
    role: Identity;
    session: { parentChannelId: string };
    lastPolledAt: number;
    archived: boolean;
    turnSeq?: number;
    cornerState?: { state: string; reason?: string };
    attentionNarrativePending?: boolean;
    mergeTarget?: { repo: string; branch: string; tip: string };
  };
}

describe('corner state record signing', () => {
  const owner = newIdentity('agent');

  it('publishes kind:30078 keyed by d=buzz-corner-state:<cornerId> with h=parentRoom', () => {
    const event = signCornerStateRecord('room-1', 'corner-9', owner, 'working', undefined, 1000);
    expect(event.kind).toBe(30078);
    expect(event.created_at).toBe(1000);
    expect(event.tags).toContainEqual(['d', 'buzz-corner-state:corner-9']);
    expect(event.tags).toContainEqual(['h', 'room-1']);
    expect(event.tags).toContainEqual(['t', 'buzz-corner-state']);
    expect(event.tags).toContainEqual(['state', 'working']);
    expect(event.tags).toContainEqual(['at', '1000']);
    expect(JSON.parse(event.content)).toEqual({ state: 'working', at: 1000 });
  });

  it('carries the reason tag when one is given', () => {
    const event = signCornerStateRecord(
      'room-1',
      'corner-9',
      owner,
      'waiting-on-human',
      'review',
      1001,
    );
    expect(event.tags).toContainEqual(['state', 'waiting-on-human']);
    expect(event.tags).toContainEqual(['reason', 'review']);
  });
});

describe('CornerStatePublisher', () => {
  beforeEach(() => {
    mocks.publishEvent.mockReset();
    mocks.publishEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps strictly monotonic created_at even within one wall-clock second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000); // one fixed wall second for every publish
    const publisher = new CornerStatePublisher(newIdentity('agent'));
    const published: NostrEvent[] = [];
    mocks.publishEvent.mockImplementation(async (event: NostrEvent) => {
      published.push(event);
    });
    await publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'working' });
    await publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'idle' });
    await publisher.publish({
      parentRoomId: 'r',
      cornerId: 'c',
      state: 'waiting-on-human',
      reason: 'review',
    });
    const stamps = published.map((event) => event.created_at);
    expect(stamps).toHaveLength(3);
    expect(new Set(stamps).size).toBe(3);
    expect(stamps[1]).toBeGreaterThan(stamps[0]);
    expect(stamps[2]).toBeGreaterThan(stamps[1]);
    publisher.stop();
  });

  it('seeds restart monotonicity from the standing record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const publisher = new CornerStatePublisher(newIdentity('agent'));
    publisher.seedLastCreatedAt('c', 1_005);
    await publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'working' });
    const event = mocks.publishEvent.mock.calls[0][0] as NostrEvent;
    expect(event.created_at).toBe(1_006);
    expect(event.tags).toContainEqual(['at', '1006']);
    publisher.stop();
  });

  it('coalesces queued transitions into exactly the newest desired state', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mocks.publishEvent.mockReturnValue(gate);
    const publisher = new CornerStatePublisher(newIdentity('agent'));
    const first = publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'working' });
    void publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'idle' });
    const newest = publisher.publish({
      parentRoomId: 'r',
      cornerId: 'c',
      state: 'waiting-on-human',
      reason: 'review',
    });
    release();
    await Promise.all([first, newest]);
    expect(mocks.publishEvent).toHaveBeenCalledTimes(2);
    const event = mocks.publishEvent.mock.calls[1][0] as NostrEvent;
    expect(event.tags).toContainEqual(['state', 'waiting-on-human']);
    expect(event.tags).toContainEqual(['reason', 'review']);
    publisher.stop();
  });

  it('drains a transition queued as an active chain finalizes', async () => {
    const publisher = new CornerStatePublisher(newIdentity('agent'));
    const first = publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'working' });
    // Await the underlying active chain directly, then enqueue in the same
    // continuation where it may still be registered in `chains`.
    const active = (publisher as unknown as { chains: Map<string, Promise<void>> }).chains.get('c');
    expect(active).toBeDefined();
    await active;
    const second = publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'idle' });
    await Promise.all([first, second]);
    expect(mocks.publishEvent).toHaveBeenCalledTimes(2);
    expect((mocks.publishEvent.mock.calls[1][0] as NostrEvent).tags).toContainEqual([
      'state',
      'idle',
    ]);
    publisher.stop();
  });

  it('retries a failed publish and honours the monotonic stamp on retry', async () => {
    vi.useFakeTimers();
    mocks.publishEvent.mockRejectedValueOnce(new Error('HTTP 429 retry in 1s'));
    const publisher = new CornerStatePublisher(newIdentity('agent'));
    const done = publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'idle' });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(mocks.publishEvent.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [first, second] = mocks.publishEvent.mock.calls.map((call) => call[0] as NostrEvent);
    expect(second.created_at).toBeGreaterThan(first.created_at);
    publisher.stop();
  }, 20_000);

  it('a stopped publisher publishes nothing — planned shutdown stays silent (#384 lesson)', async () => {
    const publisher = new CornerStatePublisher(newIdentity('agent'));
    publisher.stop();
    await publisher.publish({ parentRoomId: 'r', cornerId: 'c', state: 'working' });
    expect(mocks.publishEvent).not.toHaveBeenCalled();
  });
});

/**
 * The emission funnel on Body itself. These drive the private methods through
 * a minimally-constructed Body (no relay, no sessions) and observe the
 * publisher seam.
 */
describe('Body corner state funnel', () => {
  let body: Body;
  let publishSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    body = new Body(config, newIdentity('operator'));
    publishSpy = vi.spyOn(CornerStatePublisher.prototype, 'publish').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function funnel() {
    return body as unknown as {
      setCornerState: (info: never, state: string, reason?: string) => void;
      noteCornerFailure: (info: never) => void;
    };
  }

  function tail() {
    return body as unknown as {
      evaluateCornerTailState: (info: never, seq: number | undefined) => Promise<void>;
      seedCornerStateFromRecord: (info: never) => Promise<void>;
    };
  }

  function stubRelay(queryEvents: ReturnType<typeof vi.fn>): void {
    (body as unknown as { agentRelay: { queryEvents: typeof queryEvents } }).agentRelay = {
      queryEvents,
    };
  }

  function agentPubkey(): string {
    return (body as unknown as { agentIdentity: Identity }).agentIdentity.publicKey;
  }

  it('is edge-triggered: an unchanged state is never republished', () => {
    const info = minimalInfo('edge-1');
    funnel().setCornerState(info, 'working');
    funnel().setCornerState(info, 'working');
    expect(publishSpy).toHaveBeenCalledTimes(1);
    funnel().setCornerState(info, 'idle');
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy.mock.calls[1][0]).toMatchObject({
      parentRoomId: 'room-1',
      cornerId: 'edge-1',
      state: 'idle',
    });
  });

  it('a reason change is a transition even at the same state word', () => {
    const info = minimalInfo('edge-2');
    funnel().setCornerState(info, 'waiting-on-human', 'review');
    funnel().setCornerState(info, 'waiting-on-human', 'question');
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('an archived corner cannot publish a new state word', () => {
    const info = minimalInfo('edge-3');
    info.archived = true;
    funnel().setCornerState(info, 'working');
    expect(publishSpy).not.toHaveBeenCalled();
    funnel().setCornerState(info, 'idle');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('a disposed body publishes nothing', () => {
    const info = minimalInfo('edge-4');
    (body as unknown as { disposed: boolean }).disposed = true;
    funnel().setCornerState(info, 'working');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  describe('the failure gate (owner sharpening)', () => {
    it('failure WITH an actionable review target waits on a human', () => {
      const info = minimalInfo('fail-1');
      info.mergeTarget = { repo: 'r', branch: 'refs/heads/main', tip: 'a'.repeat(40) };
      funnel().noteCornerFailure(info);
      expect(info.attentionNarrativePending).toBe(true);
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          cornerId: 'fail-1',
          state: 'waiting-on-human',
          reason: 'failure',
        }),
      );
    });

    it('a stale approval without a live review target is idle', () => {
      const info = minimalInfo('fail-1b');
      (info as unknown as { humanMergeApproval: object }).humanMergeApproval = {
        id: 'evt',
        reviewer: 'human',
        tip: 'a'.repeat(40),
      };
      funnel().noteCornerFailure(info);
      expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
    });

    it('a concluded/stopped worker with NO artifact goes IDLE, never gold', () => {
      const info = minimalInfo('fail-2');
      funnel().noteCornerFailure(info);
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cornerId: 'fail-2', state: 'idle' }),
      );
      expect(publishSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: 'waiting-on-human' }),
      );
    });
  });

  describe('turn-tail emissions', () => {
    it('a standing ask publishes waiting-on-human/question', async () => {
      const info = minimalInfo('tail-1');
      const queryEvents = vi.fn().mockResolvedValue([
        {
          id: 'e1',
          pubkey: agentPubkey(),
          created_at: 50,
          content: 'Which base branch do you want this rebased onto?',
          tags: [['t', 'agent-message']],
        },
      ]);
      stubRelay(queryEvents);
      await tail().evaluateCornerTailState(info as never, undefined);
      expect(queryEvents).toHaveBeenCalled();
      expect(info.cornerState).toEqual({ state: 'waiting-on-human', reason: 'question' });
    });

    it('quiet narration publishes plain idle', async () => {
      const info = minimalInfo('tail-2');
      stubRelay(
        vi.fn().mockResolvedValue([
          {
            id: 'e2',
            pubkey: agentPubkey(),
            created_at: 60,
            content: 'Committed the refactor and pushed the branch.',
            tags: [['t', 'agent-message']],
          },
        ]),
      );
      await tail().evaluateCornerTailState(info as never, undefined);
      expect(info.cornerState).toEqual({ state: 'idle' });
    });

    it('a newer turn always wins over a resolving stale tail evaluation', async () => {
      const info = minimalInfo('tail-3');
      let resolveQuery!: (events: unknown) => void;
      stubRelay(vi.fn().mockReturnValue(new Promise((resolve) => (resolveQuery = resolve))));
      // Simulate the epoch bump of a queued message starting a NEW turn while
      // this turn's tail evaluation is still in flight.
      const pending = tail().evaluateCornerTailState(info as never, 41);
      info.turnSeq = 42;
      resolveQuery([
        {
          id: 'e3',
          pubkey: agentPubkey(),
          created_at: 70,
          content: 'Still need an answer?',
          tags: [['t', 'agent-message']],
        },
      ]);
      await pending;
      expect(info.cornerState).toBeUndefined();
    });

    it('a standing review target short-circuits the tail word', async () => {
      const info = minimalInfo('tail-4');
      info.mergeTarget = { repo: 'r', branch: 'refs/heads/main', tip: 'b'.repeat(40) };
      const queryEvents = vi.fn();
      stubRelay(queryEvents);
      await tail().evaluateCornerTailState(info as never, undefined);
      expect(queryEvents).not.toHaveBeenCalled();
      expect(info.cornerState).toBeUndefined();
    });

    it('an unreadable corner channel keeps the last word standing', async () => {
      const info = minimalInfo('tail-5');
      stubRelay(vi.fn().mockRejectedValue(new Error('relay down')));
      await tail().evaluateCornerTailState(info as never, undefined);
      expect(info.cornerState).toBeUndefined();
    });
  });

  describe('restore seeding', () => {
    it('re-asserts a derivable review target after restart', async () => {
      const info = minimalInfo('seed-1');
      info.mergeTarget = { repo: 'r', branch: 'refs/heads/main', tip: 'c'.repeat(40) };
      stubRelay(vi.fn().mockResolvedValue([]));
      await tail().seedCornerStateFromRecord(info as never);
      expect(info.cornerState).toEqual({ state: 'waiting-on-human', reason: 'review' });
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          cornerId: 'seed-1',
          state: 'waiting-on-human',
          reason: 'review',
        }),
      );
    });

    it('seeds from a well-formed record and republishes it on restart', async () => {
      publishSpy.mockClear();
      const parked = minimalInfo('seed-2');
      stubRelay(
        vi.fn().mockResolvedValue([
          {
            id: 'rec2',
            tags: [
              ['d', 'buzz-corner-state:seed-2'],
              ['state', 'waiting-on-human'],
              ['reason', 'question'],
              ['at', String(Math.floor(Date.now() / 1000))],
            ],
          },
        ]),
      );
      await tail().seedCornerStateFromRecord(parked as never);
      expect(parked.cornerState).toEqual({ state: 'waiting-on-human', reason: 'question' });
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          cornerId: 'seed-2',
          state: 'waiting-on-human',
          reason: 'question',
        }),
      );
    });

    it('an unreadable record read degrades to a daemon-owned working default', async () => {
      stubRelay(vi.fn().mockRejectedValue(new Error('relay down')));
      const info = minimalInfo('seed-3');
      await tail().seedCornerStateFromRecord(info as never);
      expect(info.cornerState).toEqual({ state: 'working' });
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cornerId: 'seed-3', state: 'working' }),
      );
    });
  });

  describe('attention transitions compare IN MEMORY', () => {
    it('a standing wait suppresses the card with no relay round-trip', async () => {
      const queryEvents = vi.fn();
      stubRelay(queryEvents);
      const info = minimalInfo('att-1');
      info.cornerState = { state: 'waiting-on-human', reason: 'failure' };
      const publishedCard = vi.fn().mockResolvedValue(undefined);
      await (
        body as unknown as {
          publishAttentionTransition: (i: never, p: () => Promise<void>) => Promise<void>;
        }
      ).publishAttentionTransition(info as never, publishedCard);
      expect(queryEvents).not.toHaveBeenCalled();
      expect(publishedCard).not.toHaveBeenCalled();
    });

    it('a real transition still publishes', async () => {
      const info = minimalInfo('att-2');
      info.cornerState = { state: 'working' };
      const publishedCard = vi.fn().mockResolvedValue(undefined);
      await (
        body as unknown as {
          publishAttentionTransition: (i: never, p: () => Promise<void>) => Promise<void>;
        }
      ).publishAttentionTransition(info as never, publishedCard);
      expect(publishedCard).toHaveBeenCalled();
    });
  });
});

describe('emission-point wiring (source assertions)', () => {
  const source = readFileSync(join(import.meta.dirname, 'body.ts'), 'utf8');

  it('openSubchannel publishes working', () => {
    expect(source).toMatch(
      /this\.subchannels\.set\(subchannelId, info\);\s*\n\s*\/\/ State machine[\s\S]{0,200}setCornerState\(info, 'working'\)/,
    );
  });

  it('turn start publishes working through noteCornerTurnStart', () => {
    expect(source).toMatch(
      /private noteCornerTurnStart\(info: SubchannelInfo\): void \{[\s\S]{0,200}setCornerState\(info, 'working'\)/,
    );
  });

  it('publishMergeReady publishes waiting-on-human/review on success', () => {
    expect(source).toMatch(/setCornerState\(info, 'waiting-on-human', 'review'\)/);
  });

  it('every failure site routes through the gated noteCornerFailure funnel', () => {
    const gateSites = source.match(/this\.noteCornerFailure\(info\)/g) ?? [];
    expect(gateSites.length).toBeGreaterThanOrEqual(4);
    // The only direct failure transition is inside the gate itself; emission
    // sites call `noteCornerFailure` rather than bypassing it.
    expect(source.match(/setCornerState\(info, 'waiting-on-human', 'failure'\)/g)).toHaveLength(1);
  });

  it('land and archive fold the three-state record to idle while terminal facts stay separate', () => {
    expect(source).toContain("setCornerState(info, 'idle')");
    expect(source).toMatch(/cornerId: subchannelId,\s*state: 'idle'/);
    expect(source).not.toContain("state: 'finished'");
  });

  it('the turn tail decides question vs idle via the promoted ask detection', () => {
    expect(source).toMatch(/standingAskFromEvents\(events, this\.agentIdentity\.publicKey\)/);
    expect(source).toMatch(/void this\.evaluateCornerTailState\(info, turnSeq\)/);
  });

  it('restart restore seeds the baseline from the record', () => {
    expect(source).toContain('await this.seedCornerStateFromRecord(info, events);');
  });

  it('attention suppression is the in-memory compare only — no history re-read remains', () => {
    const fnStart = source.indexOf('private publishAttentionTransition');
    const fnEnd = source.indexOf('private writeParentCornerStatus');
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toContain("info.cornerState?.state === 'waiting-on-human'");
    expect(fn).not.toContain('queryEvents');
    expect(fn).not.toContain('standingCornerStatusFromEvents');
    expect(source).not.toContain('standingCornerStatusFromEvents');
  });
});
