import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const channels = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const cacheSync = readFileSync(
  new URL('../../../buzz/local-cache-sync.ts', import.meta.url),
  'utf8',
);

describe('closed corners use the normalized lifecycle snapshot', () => {
  it('has no viewer-local corner tombstone or relay-derived fallback', () => {
    expect(existsSync(new URL('../../../buzz/closed-corners.ts', import.meta.url))).toBe(false);
    expect(channels).toContain('cornerSummariesFromSnapshot');
    expect(cacheSync).toContain('selectCorners(snapshot, roomId)');
    expect(channels).not.toMatch(/closedCorner|dismissedCorner|buzz-corner-close/);
  });
});
