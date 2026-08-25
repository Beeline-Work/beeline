import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The invariant: the foreground never waits on a network round-trip, and never
 * processes a network response on the interaction that triggered it.
 *
 * `room-entry.test.ts` proves the enter-room mechanism behaviourally. This file
 * is the boundary rule that stops the shape from coming back somewhere else —
 * a second screen growing its own serial hydration chain, an unbatched live
 * subscription, or a wall-clock timer that wakes a whole list forever.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const chatSource = read('../app/(app)/buzz/chat/[channelId].tsx');
const channelsSource = read('../app/(app)/buzz/channels.tsx');
const cornersSource = read('../app/(app)/buzz/corners/[roomId].tsx');
const membersSource = read('../app/(app)/buzz/MembersScreen.tsx');

const BUZZ_SCREENS: [name: string, source: string][] = [
  ['chat/[channelId].tsx', chatSource],
  ['channels.tsx', channelsSource],
  ['corners/[roomId].tsx', cornersSource],
  ['MembersScreen.tsx', membersSource],
];

/** Index just past the `}` closing the block whose `{` sits at `braceIndex`. */
function endOfBlock(source: string, braceIndex: number): number {
  let depth = 0;
  for (let index = braceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('unterminated block');
}

/**
 * The enter-room hydration path: the effect body minus the live-subscription
 * installer it hands to `hydrateRoomEntry`.
 *
 * The installer legitimately awaits WebSocket handshakes inside itself — the
 * invariant is that nothing on the path a person is waiting on awaits *it*.
 */
function roomHydrationPath(): string {
  const start = chatSource.indexOf('  useEffect(() => {\n    if (!decodedId) return;');
  expect(start, 'room hydration effect not found').toBeGreaterThanOrEqual(0);
  const end = chatSource.indexOf('}, [decodedId, notificationResponseId', start);
  expect(end, 'room hydration effect end not found').toBeGreaterThan(start);
  const effect = chatSource.slice(start, end);

  const installerStart = effect.indexOf('const installLiveDelivery = async (');
  expect(installerStart, 'installLiveDelivery not found').toBeGreaterThanOrEqual(0);
  // Its parameter is destructured, so skip past the arrow before brace-matching.
  const bodyBrace = effect.indexOf('=> {', installerStart) + '=> '.length;
  expect(bodyBrace, 'installLiveDelivery body not found').toBeGreaterThan(installerStart);
  return effect.slice(0, installerStart) + effect.slice(endOfBlock(effect, bodyBrace));
}

describe('no foreground-blocking network work', () => {
  it('hydrates a Room through the fanned-out plan, not a serial await chain', () => {
    const effect = roomHydrationPath();
    expect(effect).toContain('hydrateRoomEntry(');

    // Only local storage reads and the (I/O-free) shared-client constructor
    // may be awaited directly here. Anything else is a relay round-trip that
    // would sit in front of the first painted frame.
    const awaited = [...effect.matchAll(/await ([A-Za-z_$][\w$.]*)\(/g)].map((match) => match[1]);
    expect(awaited.sort()).toEqual(
      [
        'getEffectiveRelayUrl',
        'hydrateRoomEntry',
        'loadBuzzIdentity',
        't.cornerLifecycleSubscribeReady',
        't.ensureClient',
      ].sort(),
    );
  });

  it('never awaits a live-subscription handshake before showing the Room', () => {
    const effect = roomHydrationPath();
    // sessionEventsSubscribeReady/agentPresenceSubscribeReady open a WebSocket
    // and complete NIP-42 AUTH, with a 15s connect timeout. Awaiting one of
    // them ahead of the reads is exactly the bug this task removed.
    for (const handshake of [
      'await t.sessionEventsSubscribeReady',
      'await t.agentPresenceSubscribeReady',
      'await t.agentDraftSubscribeReady',
      'await installLiveDelivery',
      'await installLiveMessages',
      'await installLivePresence',
      'await installLiveDraft',
    ]) {
      expect(effect, `${handshake} must not gate the Room`).not.toContain(handshake);
    }
    // …and no fixed sleep may sit on the path either.
    expect(effect).not.toMatch(/await new Promise\(\s*\(resolve\) => setTimeout/);
  });

  it('seeds every Room-scoped screen from cache before it paints', () => {
    // chat renders the cached transcript; corners render the cached corner list.
    expect(chatSource).toContain('initialChannelCache');
    expect(cornersSource).toContain('seedFromRoomListCache');
    expect(cornersSource).toContain('useState(!seed.hasCache)');
  });

  it('coalesces live event bursts instead of writing the cache per event', () => {
    // `cacheLiveSessionEvents` rebuilds and re-sorts a Room's whole message
    // array per call and then notifies every store subscriber. A corner
    // streaming its reply delivers one raw event per token, so a subscription
    // handler must queue into a frame batch, never call the cache directly.
    for (const [name, source] of BUZZ_SCREENS) {
      expect(source, `${name} must not use the single-event cache write`).not.toMatch(
        /\bcacheLiveSessionEvent\(/,
      );
    }
    expect(channelsSource).toContain('requestAnimationFrame(flush)');
    expect(chatSource).toContain('requestAnimationFrame(flushLiveEvents)');
  });

  it('processes relay responses behind the interaction, not inside it', () => {
    for (const source of [chatSource, channelsSource, cornersSource]) {
      expect(source).toContain("from '@/buzz/defer-interaction'");
      expect(source).toContain('afterInteractions(');
    }
  });

  it('wakes on a presence deadline instead of a wall-clock re-render timer', () => {
    // A repeating timer that bumps `presenceNow` recreates a FlatList's
    // renderItem and re-renders every visible row forever, whether or not any
    // lease actually expired.
    for (const [name, source] of BUZZ_SCREENS) {
      expect(source, `${name} must not poll presence on a wall clock`).not.toMatch(
        /setInterval\(\s*\(\)\s*=>\s*setPresenceNow/,
      );
    }
    for (const [name, source] of [
      ['chat/[channelId].tsx', chatSource],
      ['corners/[roomId].tsx', cornersSource],
      ['MembersScreen.tsx', membersSource],
    ] as [string, string][]) {
      expect(source, `${name} must arm a presence-deadline timer`).toContain(
        'AGENT_PRESENCE_STALE_MS',
      );
    }
  });
});
