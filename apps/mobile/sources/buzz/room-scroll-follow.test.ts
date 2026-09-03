import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scrollFollowOnArrival } from './room-scroll-follow';

const chatSource = readFileSync(
  path.join(__dirname, '..', 'app', '(app)', 'beeline', 'chat', '[channelId].tsx'),
  'utf8',
);

/**
 * The captain's scroll rule (2026-09): a new message or live draft in the
 * open Room/corner always brings the viewport to the newest end — once per
 * arrival — but a user drag in progress is never interrupted.
 */
describe('scrollFollowOnArrival', () => {
  it('scrolls once for a genuinely new arrival', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'msg-1',
        nextNewestId: 'msg-2',
        isUserDragging: false,
      }),
    ).toBe('scroll');
  });

  it('holds on a cold open (the transcript already lands on the tail)', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: null,
        nextNewestId: 'msg-1',
        isUserDragging: false,
      }),
    ).toBe('hold');
  });

  it('holds when no new row arrived (stream tokens re-render, not arrive)', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'draft-1',
        nextNewestId: 'draft-1',
        isUserDragging: false,
      }),
    ).toBe('hold');
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'msg-1',
        nextNewestId: null,
        isUserDragging: false,
      }),
    ).toBe('hold');
  });

  it('never interrupts a user drag in progress', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'msg-1',
        nextNewestId: 'msg-2',
        isUserDragging: true,
      }),
    ).toBe('hold');
  });
});

describe('the chat screen wires the scroll rule', () => {
  it('scrolls once per arrival through the pure decision, tracking drags on the FlatList', () => {
    expect(chatSource).toContain("from '@/buzz/room-scroll-follow'");
    expect(chatSource).toContain('scrollFollowOnArrival(');
    // One scroll call per arrival, off the render path.
    expect(chatSource.match(/scrollToOffset\({ offset: 0/g)).toHaveLength(1);
    // Drag and momentum tracking feed the hold decision.
    for (const handler of [
      'onScrollBeginDrag',
      'onScrollEndDrag',
      'onMomentumScrollBegin',
      'onMomentumScrollEnd',
    ]) {
      expect(chatSource).toContain(handler);
    }
  });
});
