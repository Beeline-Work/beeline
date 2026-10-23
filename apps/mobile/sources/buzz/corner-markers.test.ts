import { describe, expect, it } from 'vitest';
import { anchorCornerMarkers } from './corner-markers';

type Row = { id: string; relayId?: string; text?: string; daemonFact?: { sourceMessageId?: string; type?: string } };

const message = (id: string): Row => ({ id, relayId: id, text: id });
const marker = (id: string, source: string): Row => ({
  id,
  relayId: id,
  daemonFact: { type: 'corner-open', sourceMessageId: source },
});

describe('anchorCornerMarkers', () => {
  it('moves a corner-opened card beneath the message it was opened from', () => {
    const rows: Row[] = [message('a'), message('b'), message('c'), marker('m1', 'a')];
    const anchored = anchorCornerMarkers(rows);
    expect(anchored.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(anchored[0]!.cornerMarkers?.map((row) => row.id)).toEqual(['m1']);
    expect(anchored[1]!.cornerMarkers).toBeUndefined();
  });

  it('keeps every corner opened from one message, in the order they were opened', () => {
    const anchored = anchorCornerMarkers([
      message('a'),
      marker('m1', 'a'),
      message('b'),
      marker('m2', 'a'),
    ]);
    expect(anchored.map((row) => row.id)).toEqual(['a', 'b']);
    expect(anchored[0]!.cornerMarkers?.map((row) => row.id)).toEqual(['m1', 'm2']);
  });

  it('hides a marker until its source is resident', () => {
    const rows = [message('b'), marker('m1', 'older-history')];
    expect(anchorCornerMarkers(rows)).toEqual([message('b')]);
    expect(anchorCornerMarkers([message('older-history'), ...rows])[0].cornerMarkers?.[0].id).toBe('m1');
  });

  it('never hangs a marker under another marker', () => {
    const anchored = anchorCornerMarkers([marker('m1', 'gone'), marker('m2', 'm1')]);
    expect(anchored.map((row) => row.id)).toEqual([]);
    expect(anchored.every((row) => !row.cornerMarkers)).toBe(true);
  });

  it('finds the source by its server id when the display id differs', () => {
    const anchored = anchorCornerMarkers([
      { id: 'local-1', relayId: 'server-1', text: 'sent' },
      marker('m1', 'server-1'),
    ]);
    expect(anchored).toHaveLength(1);
    expect(anchored[0]!.cornerMarkers?.map((row) => row.id)).toEqual(['m1']);
  });
});

it('never attaches a settled close to its source as a visible closed marker', () => {
  const source = { id: 'source', text: 'Open a corner' };
  const closed = { id: 'closed', daemonFact: { type: 'corner-complete', sourceMessageId: 'source' } };
  const rows = anchorCornerMarkers([source, closed]);
  expect(rows).toEqual([source, closed]);
  expect(rows[0]).not.toHaveProperty('cornerMarkers');
});

it('Reproduction R1: hides legacy unanchored corner rows', () => {
  expect(anchorCornerMarkers([message('a'), { id: 'legacy', daemonFact: { type: 'corner-open' } }])).toEqual([message('a')]);
});
