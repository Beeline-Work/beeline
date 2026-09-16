import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { desktopTailLanding, tailFollowStalled } from './room-scroll-follow';

const chatSource = readFileSync(
  new URL('../app/(app)/beeline/chat/[channelId].tsx', import.meta.url),
  'utf8',
);

describe('desktopTailLanding', () => {
  it('re-lands while the measured tail gap is above the pin threshold', () => {
    expect(
      desktopTailLanding({
        tailGapAboveThreshold: true,
        tailStable: false,
        isUserScrolling: false,
        readerMovedUp: false,
        landingsRemaining: 20,
      }),
    ).toEqual({ land: true, disarm: false });
  });

  it('waits while a closed tail gap is still settling', () => {
    expect(
      desktopTailLanding({
        tailGapAboveThreshold: false,
        tailStable: false,
        isUserScrolling: false,
        readerMovedUp: false,
        landingsRemaining: 20,
      }),
    ).toEqual({ land: false, disarm: false });
  });

  it('disarms once the closed tail gap is stable', () => {
    expect(
      desktopTailLanding({
        tailGapAboveThreshold: false,
        tailStable: true,
        isUserScrolling: false,
        landingsRemaining: 20,
      }),
    ).toEqual({ land: false, disarm: true });
  });

  it('a fresh user scroll vetoes and disarms the follow', () => {
    expect(
      desktopTailLanding({
        tailGapAboveThreshold: true,
        tailStable: false,
        isUserScrolling: true,
        readerMovedUp: false,
        landingsRemaining: 20,
      }),
    ).toEqual({ land: false, disarm: true });
  });

  it('a reader who moved up away from the held tail vetoes and disarms, even with budget left', () => {
    // A scrollbar drag or PageUp leaves no wheel/touch event on web, but it
    // lowers scrollTop below the offset the follow last held the reader at —
    // the open gap it leaves behind must never read as "re-land them".
    expect(
      desktopTailLanding({
        tailGapAboveThreshold: true,
        tailStable: false,
        isUserScrolling: false,
        readerMovedUp: true,
        landingsRemaining: 20,
      }),
    ).toEqual({ land: false, disarm: true });
    expect(
      desktopTailLanding({
        tailGapAboveThreshold: false,
        tailStable: false,
        isUserScrolling: false,
        readerMovedUp: true,
        landingsRemaining: 20,
      }),
    ).toEqual({ land: false, disarm: true });
  });

  it('the cap is a backstop: spent cap disarms, never lands', () => {
    expect(
      desktopTailLanding({
        tailGapAboveThreshold: true,
        tailStable: false,
        isUserScrolling: false,
        readerMovedUp: false,
        landingsRemaining: 0,
      }),
    ).toEqual({ land: false, disarm: true });
  });
});

describe('tailFollowStalled', () => {
  const EPS = 1;

  it('a landing that reached the bottom is never stalled, even when the measured gap then grows', () => {
    // Measured on a 500-row transcript: every landing reaches the
    // then-current bottom and RN Web then measures rows above the
    // viewport, so the gap grows 618 → 613 → 1246 → … — none of that is
    // a stalled follow.
    expect(
      tailFollowStalled(
        { scrollHeight: 17000, scrollTop: 15000 },
        { scrollHeight: 17618, scrollTop: 15000 },
        EPS,
      ),
    ).toBe(false);
  });

  it('a landing that changes nothing is stalled', () => {
    expect(
      tailFollowStalled(
        { scrollHeight: 20446, scrollTop: 15119 },
        { scrollHeight: 20446, scrollTop: 15119 },
        EPS,
      ),
    ).toBe(true);
  });

  it('missing state on either side is not a stall', () => {
    expect(tailFollowStalled(null, { scrollHeight: 10, scrollTop: 0 }, EPS)).toBe(false);
    expect(tailFollowStalled({ scrollHeight: 10, scrollTop: 0 }, null, EPS)).toBe(false);
  });
});

describe('desktop tail landing wiring', () => {
  it('arms the cap on the desktop arrival path', () => {
    const arrivalEffect = chatSource.slice(
      chatSource.indexOf('const arrivalFollow = useScrollFollowOnArrival'),
      chatSource.indexOf('// Reveal the exact fact that caused the alert.'),
    );
    expect(arrivalEffect).toContain('desktopTailLandingsRef.current = DESKTOP_TAIL_LANDING_CAP;');
  });

  it('does not trust provisional onScroll metrics to disarm the follow', () => {
    const onScroll = chatSource.slice(
      chatSource.indexOf('onScroll={(event) => {'),
      chatSource.indexOf('scrollEventThrottle={100}'),
    );
    expect(onScroll).not.toContain('desktopTailLandingsRef.current');
    expect(onScroll).not.toContain('contentSize.height - layoutMeasurement.height');
  });

  it('stamps wheel and touch activity from the web scroll node', () => {
    expect(chatSource).toContain("scrollNode.addEventListener('wheel', disarmDesktopTailFollow");
    expect(chatSource).toContain('userScrolledAtRef.current = Date.now();');
    expect(chatSource).toContain(
      "scrollNode.addEventListener('touchmove', disarmDesktopTailFollow",
    );
    expect(chatSource).not.toContain('onWheel={() => {');
    expect(chatSource).not.toContain('onTouchMove={() => {');
  });

  it('converges on the measured tail gap from the content size change', () => {
    const contentSizeChange = chatSource.slice(
      chatSource.indexOf('onContentSizeChange={(_width, height) => {'),
      chatSource.indexOf('renderItem={renderItem}'),
    );
    expect(contentSizeChange).toContain('desktopTailLanding({');
    expect(contentSizeChange).toContain('getScrollableNode()');
    expect(contentSizeChange).toContain(
      'scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop',
    );
    expect(contentSizeChange).toContain('DESKTOP_TAIL_SETTLE_MS');
    expect(contentSizeChange).toContain('DESKTOP_TAIL_POLL_MS');
    expect(contentSizeChange).toContain(
      'settledNode.scrollHeight - settledNode.clientHeight - settledNode.scrollTop',
    );
    expect(contentSizeChange).toContain('TAIL_PIN_THRESHOLD');
    expect(contentSizeChange).toContain('DESKTOP_USER_SCROLL_WINDOW_MS');
    expect(contentSizeChange).toContain('readerMovedUp');
    expect(contentSizeChange).toContain('landing.disarm');
    expect(contentSizeChange.indexOf('if (desktopTranscript) {')).toBeLessThan(
      contentSizeChange.indexOf('preserveReaderOffsetUntilRef'),
    );
  });

  it('records the held reader offset on arm and on every landing', () => {
    // The reader-motion guard needs a baseline the follow itself placed the
    // reader at; both decision sites compare against it and any disarm
    // clears it so a stale offset can never outlive the follow.
    expect(chatSource).toContain('desktopTailHeldOffsetRef.current = armNode');
    expect(chatSource.match(/desktopTailHeldOffsetRef\.current =/g)?.length).toBeGreaterThanOrEqual(
      6,
    );
  });

  it('charges the budget only for a stalled landing, at both decision sites', () => {
    // The cap must never become a transcript-length limit: a landing that
    // reached the bottom it was shown is still converging (RN Web reopens
    // the gap by measuring rows above the viewport), so the content size
    // site and the settle poll both refund it and charge only a landing
    // that left the follow unchanged.
    const stalledSites = chatSource.match(/tailFollowStalled\(/g)?.length ?? 0;
    expect(stalledSites).toBeGreaterThanOrEqual(2);
    expect(chatSource).toContain('DESKTOP_TAIL_STALL_EPS');
    expect(chatSource).toContain('desktopTailLastLandRef.current = null');
  });
});
