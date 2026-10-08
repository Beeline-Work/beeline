import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ROOM_OPEN_LIST_TAIL_PADDING } from './room-open-geometry';
import {
  phoneTranscriptTailPadding,
  roomOpenLandsOnTail,
  scrollFollowOnArrival,
  scrollFollowOnLayoutChange,
} from './room-scroll-follow';

const chatSource = readFileSync(
  path.join(__dirname, '..', 'app', '(app)', 'beeline', 'chat', '_chat-surface.tsx'),
  'utf8',
);

describe('phoneTranscriptTailPadding', () => {
  const ordinaryTail = phoneTranscriptTailPadding({ turnChromeVisible: false });

  it('does not step when the thinking line paints or clears', () => {
    const thinking = phoneTranscriptTailPadding({ turnChromeVisible: true });
    const thinkingThenIdle = phoneTranscriptTailPadding({ turnChromeVisible: false });

    expect(thinking).toBe(ordinaryTail);
    expect(thinkingThenIdle).toBe(ordinaryTail);
  });

  it('stays at the ordinary list tail, never the hanging-line height on top of it', () => {
    const thinking = phoneTranscriptTailPadding({ turnChromeVisible: true });

    expect(ordinaryTail).toBe(ROOM_OPEN_LIST_TAIL_PADDING);
    expect(thinking).toBe(ordinaryTail);
    expect(thinking).not.toBeGreaterThan(ordinaryTail);
    expect(thinking - ordinaryTail).toBe(0);
  });
});

/**
 * The captain's scroll rule (2026-09): a new message or live draft in the
 * open Room/corner follows only while the reader is at the newest end;
 * history and an active drag are never interrupted.
 */
describe('scrollFollowOnArrival', () => {
  it('scrolls once for a genuinely new arrival', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'msg-1',
        nextNewestId: 'msg-2',
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('scroll');
  });

  it('holds on a cold open (the transcript already lands on the tail)', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: null,
        nextNewestId: 'msg-1',
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('hold');
  });

  it('scrolls a chronological cold open (the desktop list starts at its top)', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: null,
        nextNewestId: 'msg-1',
        isPinnedToTail: true,
        isUserDragging: false,
        openLandsOnTail: false,
      }),
    ).toBe('scroll');
  });

  it('holds a chronological cold open that lands on the tail by itself', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: null,
        nextNewestId: 'msg-1',
        isPinnedToTail: true,
        isUserDragging: false,
        openLandsOnTail: true,
      }),
    ).toBe('hold');
  });

  it('holds when no new row arrived (stream tokens re-render, not arrive)', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'draft-1',
        nextNewestId: 'draft-1',
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('hold');
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'msg-1',
        nextNewestId: null,
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('hold');
  });

  it('holds an in-place lifecycle update while the reader is in history', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'card-1',
        nextNewestId: 'card-1',
        isPinnedToTail: false,
        isUserDragging: false,
      }),
    ).toBe('hold');

    const arrivalKey = chatSource.slice(
      chatSource.indexOf('const newestMessageId ='),
      chatSource.indexOf('const arrivalFollow ='),
    );
    expect(arrivalKey).toContain("foldedMessages.at(-1)?.id ?? null");
    expect(arrivalKey).not.toContain('notificationLifecycleRun');
  });

  it('never interrupts a user drag in progress', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'msg-1',
        nextNewestId: 'msg-2',
        isPinnedToTail: true,
        isUserDragging: true,
      }),
    ).toBe('hold');
  });

  it('preserves the reader position when a new Room message arrives in history', () => {
    expect(
      scrollFollowOnArrival({
        previousNewestId: 'msg-1',
        nextNewestId: 'msg-2',
        isPinnedToTail: false,
        isUserDragging: false,
      }),
    ).toBe('hold');
  });
});

/**
 * C97: a send that collapses the composer (attach removed, field snaps back
 * to its minimum height) or dismisses the keyboard opens a gap that the
 * arrival rule above never sees, since no new row id shows up. This rule
 * follows that layout change directly instead of widening
 * `autoscrollToTopThreshold`.
 */
describe('scrollFollowOnLayoutChange', () => {
  it('snaps to the tail when the footprint shrinks while pinned to the tail', () => {
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 300,
        nextFootprint: 40,
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('scroll');
  });

  it('holds the same shrink when the reader has scrolled back to read history', () => {
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 300,
        nextFootprint: 40,
        isPinnedToTail: false,
        isUserDragging: false,
      }),
    ).toBe('hold');
  });

  it('never interrupts a drag or its momentum, even pinned to the tail', () => {
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 300,
        nextFootprint: 40,
        isPinnedToTail: true,
        isUserDragging: true,
      }),
    ).toBe('hold');
  });

  it('holds before the first measurement', () => {
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: null,
        nextFootprint: 40,
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('hold');
  });

  it('holds when the footprint grows or stays flat (opening the keyboard, not closing it)', () => {
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 40,
        nextFootprint: 300,
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('hold');
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 300,
        nextFootprint: 300,
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('hold');
  });

  it('snaps when fixed corner and turn chrome mounts below the list', () => {
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 40,
        nextFootprint: 40,
        previousLayoutKey: 'no-corner:no-turn',
        nextLayoutKey: 'corner:turn',
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('scroll');
  });

  it('asks to follow again for each independently mounted status line', () => {
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 340,
        nextFootprint: 340,
        previousLayoutKey: 'no-corner:no-turn:online',
        nextLayoutKey: 'no-corner:turn:online',
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('scroll');
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 340,
        nextFootprint: 340,
        previousLayoutKey: 'no-corner:turn:online',
        nextLayoutKey: 'corner:turn:online',
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('scroll');
    expect(
      scrollFollowOnLayoutChange({
        previousFootprint: 340,
        nextFootprint: 340,
        previousLayoutKey: 'corner:turn:online',
        nextLayoutKey: 'corner:turn:offline',
        isPinnedToTail: true,
        isUserDragging: false,
      }),
    ).toBe('scroll');
  });
});

describe('the chat screen wires the scroll rule', () => {

  it('scrolls once per arrival through the pure decision, tracking drags on the FlatList', () => {
    expect(chatSource).toContain("from '@/buzz/room-scroll-follow'");
    expect(chatSource).toContain('useScrollFollowOnArrival({');
    // One follow request per arrival, off the render path; the scroll
    // controller owns the list call.
    expect(chatSource).toContain('scrollController.follow();');
    expect(chatSource).not.toContain('scrollToOffset(');
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

  it('lands the desktop transcript on the newest message on open', () => {
    // A chronological list starts at its top, so the open must scroll; an
    // inverted native list already shows the tail. A bookmark/notification
    // message id must not take that landing.
    expect(chatSource).toContain('roomOpenLandsOnTail');
    expect(chatSource).toContain('messageAnchorId');
    expect(roomOpenLandsOnTail({ desktopTranscript: false })).toBe(true);
    expect(roomOpenLandsOnTail({ desktopTranscript: true })).toBe(false);
    expect(
      roomOpenLandsOnTail({ desktopTranscript: false, messageAnchorId: 'msg-1' }),
    ).toBe(false);
    // Cold open and append share the same measured-DOM landing: the content
    // node's own ResizeObserver fires with the full mounted height on
    // `.observe()`, so the first fire already lands on real DOM instead of
    // a separate scrollToEnd/onContentSizeChange estimate.
    expect(chatSource).toContain('shouldFollowDesktopTail');
    expect(chatSource).toContain('new ResizeObserver(');
    expect(chatSource).toContain('scrollController.followNow()');
  });

  it('follows a composer/keyboard footprint drop while pinned to the tail', () => {
    expect(chatSource).toContain('useScrollFollowOnLayoutChange({');
    expect(chatSource).toContain('isPinnedToTail: scrollController.isPinnedToTail()');
    expect(chatSource).toContain('useKeyboardState(');
    expect(chatSource).toContain('bottomChromeLayoutKey');
  });

  it('keeps the phone turn line out of the composer footprint and the tail padding', () => {
    expect(chatSource).toContain('const composerFootprint = composerHeight + keyboardHeight;');
    // The band's own strip is `TurnBandSlot`, a sibling of the composer row
    // holding its own measured height — not part of the composer's footprint.
    expect(chatSource).toContain('<TurnBandSlot');
    expect(chatSource).toContain('paddingTop: phoneTranscriptTailPadding({');
    expect(chatSource).toContain('turnChromeVisible: Boolean(composerAck || settledTurn)');
    expect(chatSource).toContain('styles.bottomChromeStack');
    expect(chatSource).not.toContain('(composerAck || settledTurn) && {');
  });

  /**
   * A reply started from a message the reader scrolled up to read (a
   * multi-page message, say) otherwise keeps that same scroll offset while
   * the keyboard and reply banner shrink the viewport — which reads as the
   * transcript jumping to center the replied-to message instead of staying
   * on the end of the log the reply reference already gives context for.
   * `beginReply` must land back on the tail through the same
   * `scrollToNewestMessage` the arrival/layout-change rules use, not a
   * fresh `scrollToIndex` on the replied message (that stays reserved for
   * jumping to a tapped reply reference).
   */
  it('scrolls to the end of the log when a reply is started, not to the replied message', () => {
    const beginReply = chatSource.slice(
      chatSource.indexOf('const beginReply = useCallback'),
      chatSource.indexOf('const handleReactToMessage = useCallback'),
    );
    const install = beginReply.slice(
      beginReply.indexOf('const install = () => {'),
      beginReply.indexOf('};', beginReply.indexOf('const install = () => {')),
    );
    expect(install).toContain("scrollController.request({ kind: 'newest' });");
    expect(install).not.toContain('scrollToIndex');
    expect(beginReply).toContain(
      '[applyComposerPrefill, decodedId, replyTargetForMessage, scrollController]',
    );
  });
});
