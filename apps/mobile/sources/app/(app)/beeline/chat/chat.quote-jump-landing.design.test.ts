import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the quote/notification-jump scroll wobble: tapping
 * a quoted message's reference line (or landing from a push notification,
 * forward source, or Squire card source — all the same `notificationMessageId`
 * landing path) used to settle in multiple visibly distinct scroll positions
 * because the re-center after the initial jump was re-issued on a schedule
 * (first a fixed [400, 1200]ms wall-clock ladder, then a fixed two-animation-
 * frame delay) instead of on the reader's own viewability report. A guessed
 * delay can fire before a distant target's `onScrollToIndexFailed` retries
 * have brought it into range, re-centering — or flashing — a row that is
 * still off-window or clipped. See `buzz/message-source-landing.ts` for the
 * decision logic and its own behavioral tests; this file locks in the
 * structural facts that logic alone can't: neither retry-on-a-clock shape
 * survives, and the settle is wired to the real viewability report.
 */
const chatSurfaceSource = readFileSync(
  fileURLToPath(new URL('./_chat-surface.tsx', import.meta.url)),
  'utf8',
);

describe('message-source landing settles on viewability, never a clock', () => {
  it('no longer re-issues the correction on a fixed [400, 1200]ms retry ladder', () => {
    expect(chatSurfaceSource).not.toMatch(/\[400,\s*1200\]/);
  });

  it('no longer guesses a fixed animation-frame delay for the correction', () => {
    // The jump effect schedules exactly one `scheduleAnimationFrame` — the
    // one that defers the initial scrollToIndex off the render path — never
    // a nested pair racing onScrollToIndexFailed's own retries.
    const effect = chatSurfaceSource.slice(
      chatSurfaceSource.indexOf('Reveal the exact fact that caused the alert'),
      chatSurfaceSource.indexOf('const residentIndex = combinedMessages.findIndex'),
    );
    const scheduledFrames = effect.match(/scheduleAnimationFrame\(/g) ?? [];
    expect(scheduledFrames.length).toBe(1);
  });

  it('settles through the shared viewability report, gated by the real signal', () => {
    expect(chatSurfaceSource).toContain('shouldSettleMessageSourceLanding');
    expect(chatSurfaceSource).toContain('startMessageSourceLanding');
    // The settle check and its corrective scrollToIndex/flash live inside
    // the viewability callback, not the jump effect.
    const viewabilityCallback = chatSurfaceSource.slice(
      chatSurfaceSource.indexOf('const observeVisibleTranscriptMessages'),
      chatSurfaceSource.indexOf('Follow a new row only from the tail'),
    );
    expect(viewabilityCallback).toContain('shouldSettleMessageSourceLanding');
    expect(viewabilityCallback).toContain('raiseSourceLandingFlash');
  });

  it('flashes the settled target with the brass wash token, not a new color', () => {
    expect(chatSurfaceSource).toContain('raiseSourceLandingFlash');
  });
});
