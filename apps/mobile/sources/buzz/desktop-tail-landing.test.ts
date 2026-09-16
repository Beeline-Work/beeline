import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { desktopTailLanding } from './room-scroll-follow';

const chatSource = readFileSync(
  new URL('../app/(app)/beeline/chat/[channelId].tsx', import.meta.url),
  'utf8',
);

describe('desktopTailLanding', () => {
  it('re-lands a pinned reader while the budget lasts, spending one landing', () => {
    expect(desktopTailLanding({ landingsRemaining: 3, isUserDragging: false })).toEqual({
      land: true,
      remainingAfter: 2,
    });
    expect(desktopTailLanding({ landingsRemaining: 1, isUserDragging: false })).toEqual({
      land: true,
      remainingAfter: 0,
    });
  });

  it('refuses once the budget is spent', () => {
    expect(desktopTailLanding({ landingsRemaining: 0, isUserDragging: false })).toEqual({
      land: false,
      remainingAfter: 0,
    });
  });

  it('never moves a reader mid-drag and keeps the budget for them', () => {
    expect(desktopTailLanding({ landingsRemaining: 2, isUserDragging: true })).toEqual({
      land: false,
      remainingAfter: 2,
    });
  });
});

describe('desktop tail landing wiring', () => {
  it('arms the measured landing only on the desktop arrival path', () => {
    const arrivalEffect = chatSource.slice(
      chatSource.indexOf('const arrivalFollow = useScrollFollowOnArrival'),
      chatSource.indexOf('// Reveal the exact fact that caused the alert.'),
    );
    expect(arrivalEffect).toContain('if (desktopTranscript) {');
    expect(arrivalEffect).toContain('desktopTailLandingsRef.current = DESKTOP_TAIL_LANDINGS;');
  });

  it('lands the desktop list from the measured content size on content change', () => {
    const contentSizeChange = chatSource.slice(
      chatSource.indexOf('onContentSizeChange={(_width, height) => {'),
      chatSource.indexOf('renderItem={renderItem}'),
    );
    expect(contentSizeChange).toContain('desktopTailLanding({');
    expect(contentSizeChange).toContain(
      'flatListRef.current?.scrollToOffset({ offset: height, animated: false });',
    );
    // The desktop branch returns before the native reader-offset preserve.
    expect(contentSizeChange.indexOf('if (desktopTranscript) {')).toBeLessThan(
      contentSizeChange.indexOf('preserveReaderOffsetUntilRef'),
    );
  });

  it('does not consult the pinned verdict for the desktop landing', () => {
    const contentSizeChange = chatSource.slice(
      chatSource.indexOf('onContentSizeChange={(_width, height) => {'),
      chatSource.indexOf('renderItem={renderItem}'),
    );
    // The arrival scroll itself moves the offset before the tail window
    // measures, so isPinnedToTail would refuse the corrective landing.
    expect(contentSizeChange).not.toContain('isPinnedToTailRef.current');
  });
});
