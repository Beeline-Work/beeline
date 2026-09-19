import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  desktopOpenLandingOnContentSizeChange,
  phoneTranscriptTailPadding,
  scrollFollowOnArrival,
  scrollFollowOnLayoutChange,
} from './room-scroll-follow';

const chatSource = readFileSync(
  path.join(__dirname, '..', 'app', '(app)', 'beeline', 'chat', 'chat-surface.tsx'),
  'utf8',
);

describe('phoneTranscriptTailPadding', () => {
  it('keeps thinking + live-Corner WAITING spacing at exact idle parity', () => {
    const idleWithWaitingCorner = phoneTranscriptTailPadding({
      turnChromeVisible: false,
      pushedChromeVisible: true,
    });
    const thinkingWithWaitingCorner = phoneTranscriptTailPadding({
      turnChromeVisible: true,
      pushedChromeVisible: true,
    });

    expect(thinkingWithWaitingCorner).toBe(idleWithWaitingCorner);
  });

  it('reserves the hanging line when no Corner or offline bar pushes the transcript', () => {
    const idle = phoneTranscriptTailPadding({
      turnChromeVisible: false,
      pushedChromeVisible: false,
    });
    const thinking = phoneTranscriptTailPadding({
      turnChromeVisible: true,
      pushedChromeVisible: false,
    });

    expect(thinking - idle).toBe(30);
  });
});

/**
 * The captain's scroll rule (2026-09): a new message or live draft in the
 * open Room/corner follows the newest end only while the reader is already
 * pinned there; a user reading history or dragging is never interrupted.
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

  it('holds a new arrival while the reader is above the bottom', () => {
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

describe('desktopOpenLandingOnContentSizeChange', () => {
  it('keeps landing through measured growth without consulting the transient tail pin', () => {
    expect(
      desktopOpenLandingOnContentSizeChange({
        active: true,
        previousHeight: 1_000,
        nextHeight: 2_225,
        isUserDragging: false,
      }),
    ).toBe('scroll');
    expect(
      desktopOpenLandingOnContentSizeChange({
        active: true,
        previousHeight: 2_225,
        nextHeight: 3_325,
        isUserDragging: false,
      }),
    ).toBe('scroll');
  });

  it('settles when measurement stops growing or the reader takes control', () => {
    expect(
      desktopOpenLandingOnContentSizeChange({
        active: true,
        previousHeight: 3_325,
        nextHeight: 3_325,
        isUserDragging: false,
      }),
    ).toBe('settle');
    expect(
      desktopOpenLandingOnContentSizeChange({
        active: true,
        previousHeight: 2_225,
        nextHeight: 3_325,
        isUserDragging: true,
      }),
    ).toBe('settle');
  });

  it('holds once the open landing has settled', () => {
    expect(
      desktopOpenLandingOnContentSizeChange({
        active: false,
        previousHeight: 2_225,
        nextHeight: 3_325,
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

  it('lands the desktop transcript on the newest message on open', () => {
    // A chronological list starts at its top, so the open must scroll; an
    // inverted native list already shows the tail.
    expect(chatSource).toContain('openLandsOnTail: !desktopTranscript');
    // The immediate scrollToEnd can land short while the tail window is
    // unmeasured (RN Web estimates far frames), so the landing re-runs from
    // measured content sizes until it settles.
    expect(chatSource).toContain('desktopOpenLandingRef.current = true');
    expect(chatSource).toContain('desktopOpenLandingOnContentSizeChange({');
    expect(chatSource).toContain('onWheel: cancelDesktopOpenLanding');
    expect(chatSource).toMatch(/scrollToOffset\(\{\s*offset: height,/);
  });

  it('follows a composer/keyboard footprint drop while pinned to the tail', () => {
    expect(chatSource).toContain('useScrollFollowOnLayoutChange({');
    expect(chatSource).toContain('isPinnedToTailRef');
    expect(chatSource).toContain('useKeyboardState(');
    expect(chatSource).toContain('bottomChromeLayoutKey');
  });

  it('keeps the phone turn reserve in the transcript rather than the composer footprint', () => {
    expect(chatSource).toContain('const composerFootprint = composerHeight + keyboardHeight;');
    expect(chatSource).toContain('styles.hangingTurnChrome');
    expect(chatSource).toContain('paddingTop: phoneTranscriptTailPadding({');
    expect(chatSource).toContain(
      'pushedChromeVisible: Boolean((!isCorner && cornerLiveBar) || agentsOffline)',
    );
    expect(chatSource).toContain('styles.bottomChromeStack');
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
    expect(install).toContain('scrollToNewestMessage();');
    expect(install).not.toContain('scrollToIndex');
    expect(beginReply).toContain('[decodedId, replyTargetForMessage, scrollToNewestMessage, visibleMessages]');
  });
});
