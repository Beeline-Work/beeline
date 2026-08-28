import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

function productionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((entry) => resolve(root, entry))
    .filter(
      (entry) =>
        statSync(entry).isFile() &&
        /\.(?:ts|tsx)$/.test(entry) &&
        !entry.endsWith('.test.ts') &&
        !entry.endsWith('.test.tsx'),
    );
}

describe('server-indexed mobile data boundary', () => {
  it('has no Room parser, reducer, selectors, projection, or authoritative snapshot path', () => {
    expect(productionFiles(resolve(REPO, 'packages/buzz-client/src/read-model'))).toEqual([]);
    expect(
      existsSync(resolve(REPO, 'apps/mobile/sources/sync/transport/buzz-event-projection.ts')),
    ).toBe(false);
    expect(existsSync(resolve(REPO, 'apps/mobile/sources/buzz/local-cache.ts'))).toBe(false);
    expect(existsSync(resolve(REPO, 'apps/mobile/sources/buzz/local-cache-sync.ts'))).toBe(false);

    const mobileBuzzSource = productionFiles(resolve(REPO, 'apps/mobile/sources/app/(app)/buzz'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(mobileBuzzSource).not.toMatch(
      /read-model|buzz-event-projection|local-cache-sync|buzz\/local-cache|WorkspaceSnapshot/,
    );
  });

  it('keeps caches event-free and the retained transport write/live-only', () => {
    const surfaceSources = [
      'packages/buzz-client/src/surface-cache.ts',
      'packages/buzz-client/src/room-response-partitions.ts',
      'apps/mobile/sources/buzz/surface-storage.ts',
    ]
      .map((file) => readFileSync(resolve(REPO, file), 'utf8'))
      .join('\n');
    expect(surfaceSources).not.toMatch(/ReadEvent|WorkspaceSnapshot|read-model|NostrEvent/);

    const transport = readFileSync(
      resolve(REPO, 'apps/mobile/sources/sync/transport/buzz-rig-transport.ts'),
      'utf8',
    );
    expect(transport).not.toMatch(
      /readModelBackfill|sessionEventsBackfill|listCommunities|listChannels|channelSnapshot/,
    );
  });
});
