import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { desktopTailLanding } from './room-scroll-follow';

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
        landingsRemaining: 0,
      }),
    ).toEqual({ land: false, disarm: true });
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

  it('stamps wheel, touch, and pointer activity as web user-scroll signals', () => {
    expect(chatSource).toContain('onWheel={() => {');
    expect(chatSource).toContain('userScrolledAtRef.current = Date.now();');
    expect(chatSource).toContain('onTouchMove={() => {');
    expect(chatSource).toContain('onPointerDown={() => {');
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
    expect(contentSizeChange).toContain('landing.disarm');
    expect(contentSizeChange.indexOf('if (desktopTranscript) {')).toBeLessThan(
      contentSizeChange.indexOf('preserveReaderOffsetUntilRef'),
    );
  });
});
