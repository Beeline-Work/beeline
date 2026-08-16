import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const channelsSource = readFileSync(
  new URL('../app/(app)/buzz/channels.tsx', import.meta.url),
  'utf8',
);
const chatSource = readFileSync(
  new URL('../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const rootSource = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');

describe('Buzz cache-first startup', () => {
  it('keys the room list cache before waiting for a relay client', () => {
    const activeViewer = channelsSource.indexOf('setActiveBuzzCacheViewer(currentIdentity.publicKey);');
    const identity = channelsSource.indexOf('setIdentity(currentIdentity);', activeViewer);
    const relay = channelsSource.indexOf('await nextTransport.ensureClient();');

    expect(activeViewer).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(activeViewer);
    expect(relay).toBeGreaterThan(identity);
  });

  it('keys the transcript cache before awaiting its live subscription', () => {
    const activeViewer = chatSource.indexOf('setActiveBuzzCacheViewer(identity.publicKey);');
    const user = chatSource.indexOf('setUserPubkey(identity.publicKey);', activeViewer);
    const relay = chatSource.indexOf('await t.ensureClient();');

    expect(activeViewer).toBeGreaterThanOrEqual(0);
    expect(user).toBeGreaterThan(activeViewer);
    expect(relay).toBeGreaterThan(user);
  });

  it('persists the cache only after Android has entered the background', () => {
    const background = rootSource.indexOf("if (state === 'background')");
    const flush = rootSource.indexOf('flushBuzzLocalCacheForBackground();', background);

    expect(background).toBeGreaterThanOrEqual(0);
    expect(flush).toBeGreaterThan(background);
    expect(rootSource).not.toContain('flushTimer = setTimeout');
  });
});
