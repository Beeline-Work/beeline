import { describe, expect, it } from 'vitest';
import {
  canSettleMessageSourceLanding,
  startMessageSourceLanding,
} from './message-source-landing';

describe('canSettleMessageSourceLanding', () => {
  const context = {
    messageAnchorId: 'msg-1',
    dragSequence: 0,
    isUserDragging: false,
  };

  it('allows the one deferred correction when nothing has changed since the jump', () => {
    const landing = startMessageSourceLanding('msg-1', 0);
    expect(canSettleMessageSourceLanding(landing, context)).toBe(true);
  });

  it('refuses when there is no pending landing', () => {
    expect(canSettleMessageSourceLanding(null, context)).toBe(false);
  });

  it('refuses once the reader is mid-gesture', () => {
    const landing = startMessageSourceLanding('msg-1', 0);
    expect(
      canSettleMessageSourceLanding(landing, { ...context, isUserDragging: true }),
    ).toBe(false);
  });

  it('refuses once the drag sequence has advanced past the landing (reader touched the list, or navigated again)', () => {
    const landing = startMessageSourceLanding('msg-1', 0);
    expect(
      canSettleMessageSourceLanding(landing, { ...context, dragSequence: 1 }),
    ).toBe(false);
  });

  it('refuses once a different message owns the anchor', () => {
    const landing = startMessageSourceLanding('msg-1', 0);
    expect(
      canSettleMessageSourceLanding(landing, { ...context, messageAnchorId: 'msg-2' }),
    ).toBe(false);
  });

  it('a fresh jump to a new message starts its own landing, independent of a stale one', () => {
    const first = startMessageSourceLanding('msg-1', 0);
    const second = startMessageSourceLanding('msg-2', 1);
    // The reader jumped again before the first landing's deferred correction
    // fired. The stale landing must not settle against the new anchor/drag
    // state, and the new landing must settle on its own.
    expect(canSettleMessageSourceLanding(first, { ...context, messageAnchorId: 'msg-2', dragSequence: 1 })).toBe(false);
    expect(canSettleMessageSourceLanding(second, { ...context, messageAnchorId: 'msg-2', dragSequence: 1 })).toBe(true);
  });
});
