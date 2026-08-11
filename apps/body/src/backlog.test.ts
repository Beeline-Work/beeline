import { describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import { queryEventBacklog } from './body.js';

function event(index: number): NostrEvent {
  return {
    id: index.toString(16).padStart(64, '0'),
    pubkey: 'a'.repeat(64),
    created_at: index + 1,
    kind: 9,
    tags: [['h', 'room']],
    content: `event-${index}`,
    sig: 'b'.repeat(128),
  };
}

describe('queryEventBacklog', () => {
  it('walks backward through a full newest-first window without skipping event 101', async () => {
    const all = Array.from({ length: 101 }, (_, index) => event(index));
    const query = vi.fn(async (filters: Record<string, unknown>[]) => {
      const filter = filters[0]!;
      const since = Number(filter.since ?? 0);
      const until = Number(filter.until ?? Number.MAX_SAFE_INTEGER);
      const limit = Number(filter.limit ?? 100);
      return all
        .filter((candidate) => candidate.created_at >= since && candidate.created_at <= until)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
    });

    const result = await queryEventBacklog(
      { kinds: [9], '#h': ['room'], since: 1 },
      'a'.repeat(64),
      { pageSize: 100, query },
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(101);
    expect(result.map((item) => item.content)).toEqual(all.map((item) => item.content));
  });
});
