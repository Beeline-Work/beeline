import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the quote/notification-jump scroll wobble: tapping
 * a quoted message's reference line (or landing from a push notification,
 * forward source, or Squire card source — all the same `notificationMessageId`
 * landing path) used to settle in THREE visibly distinct scroll positions —
 * the initial jump, then a correction at a fixed 400ms, then another at a
 * fixed 1200ms — because the re-center after the initial jump was re-issued
 * on a wall-clock schedule instead of gated to run at most once. See
 * `buzz/message-source-landing.ts` for the fix and its own decision-logic
 * tests; this file locks in the two structural facts that logic alone can't:
 * the old retry ladder is gone, and the new one-shot gate is actually wired
 * into the landing effect.
 */
const chatSurfaceSource = readFileSync(
  fileURLToPath(new URL('./_chat-surface.tsx', import.meta.url)),
  'utf8',
);

describe('message-source landing settles once', () => {
  it('no longer re-issues the correction on a fixed [400, 1200]ms retry ladder', () => {
    expect(chatSurfaceSource).not.toMatch(/\[400,\s*1200\]/);
  });

  it('gates the deferred re-center through the one-shot settle check', () => {
    expect(chatSurfaceSource).toContain('canSettleMessageSourceLanding');
    expect(chatSurfaceSource).toContain('startMessageSourceLanding');
  });

  it('flashes the settled target with the brass wash token, not a new color', () => {
    expect(chatSurfaceSource).toContain('raiseSourceLandingFlash');
  });
});
