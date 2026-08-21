import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions for the Room→repo Stage 2 app UI, in the same style as
 * `roomIndicators.test.ts`: this giant screen has no render harness, so the
 * structural guarantees are checked as text — same technique
 * `no-foreground-blocking.test.ts` uses for the hydration contract.
 */
const chatSource = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');

function blockFrom(source: string, marker: string, label: string): string {
  const start = source.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const braceStart = source.indexOf('{', start);
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('Room→repo header chip', () => {
  it('renders only for a Room with a bound repo, never a corner', () => {
    const chipIndex = chatSource.indexOf('testID="room-repo-chip"');
    expect(chipIndex).toBeGreaterThanOrEqual(0);
    const guardStart = chatSource.lastIndexOf('{!isCorner && roomRepository &&', chipIndex);
    expect(
      guardStart,
      'repo chip must be gated on !isCorner && roomRepository',
    ).toBeGreaterThanOrEqual(0);
    expect(guardStart).toBeLessThan(chipIndex);
  });

  it('is fetched off the enter-room fan-out, and cleared for a corner', () => {
    const effect = blockFrom(
      chatSource,
      'useEffect(() => {\n    if (!decodedId || !transport || isCorner) {',
      'room repository fetch effect',
    );
    // The tri-state read, not the collapsing one: an error and "this Room has
    // no repository" are different answers, and only the second one licenses
    // the prompt below.
    expect(effect).toContain('roomRepositoryState');
    expect(effect).toContain('setRoomRepositoryResolved');
  });
});

describe('Room→repo corner-open lazy prompt', () => {
  it('short-circuits handleSend on a repo-less Room before the composer is cleared', () => {
    const handleSend = blockFrom(
      chatSource,
      'const handleSend = useCallback(async () => {',
      'handleSend',
    );
    const guardIndex = handleSend.indexOf('looksLikeCornerOpenIntent(rawText)');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(handleSend).toContain('roomRepoAccessIssue');
    // The composer must not be cleared before this guard — it sits before the
    // optimistic-message / setInputText('') side effects.
    expect(handleSend.indexOf("setInputText('')")).toBeGreaterThan(
      handleSend.indexOf('setCornerOpenRepoPrompt(true)'),
    );
  });

  it('offers the picker to an admin and a plain ask-an-admin hint otherwise', () => {
    const banner = blockFrom(
      chatSource,
      '{cornerOpenRepoPrompt && (',
      'corner-open repo prompt banner',
    );
    expect(banner).toContain('canManageRoomRepository(viewerChannelRole)');
    expect(banner).toContain('<RepoPicker');
    expect(banner).toContain('Ask a');
    expect(banner).toContain('ACCESS TO THIS REPO WAS REVOKED');
    expect(banner).toContain('Add this repo to the Beeline installation');
  });
});

describe('Room→repo settings change', () => {
  it('gates the set/change picker on canManageRoomRepository, leaving a read-only row otherwise', () => {
    const adminIndex = chatSource.indexOf('testID="room-repo-action"');
    const readonlyIndex = chatSource.indexOf('testID="room-repo-readonly"');
    expect(adminIndex).toBeGreaterThanOrEqual(0);
    expect(readonlyIndex).toBeGreaterThan(adminIndex);
    const guardStart = chatSource.lastIndexOf(
      '{canManageRoomRepository(viewerChannelRole) ? (',
      adminIndex,
    );
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardStart).toBeLessThan(adminIndex);
  });

  it('confirms before re-binding a repo out from under a Room with open corners', () => {
    const handler = blockFrom(
      chatSource,
      'const handleSelectRoomRepoCandidate = useCallback(',
      'handleSelectRoomRepoCandidate',
    );
    expect(handler).toContain('isCornerActive');
    expect(handler).toContain('Alert.alert');
    expect(handler).toContain('roomRepository && hasOpenCorners');
  });
});
