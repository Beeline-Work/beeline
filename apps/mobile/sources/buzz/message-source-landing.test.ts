import { describe, expect, it } from 'vitest';
import {
  canSettleMessageSourceLanding,
  shouldSettleMessageSourceLanding,
  startMessageSourceLanding,
} from './message-source-landing';

describe('canSettleMessageSourceLanding', () => {
  const context = {
    messageAnchorId: 'msg-1',
    abandoned: false,
  };

  it('allows the deferred correction when nothing has changed since the jump', () => {
    const landing = startMessageSourceLanding('msg-1');
    expect(canSettleMessageSourceLanding(landing, context)).toBe(true);
  });

  it('refuses when there is no pending landing', () => {
    expect(canSettleMessageSourceLanding(null, context)).toBe(false);
  });

  it('refuses once the reader has genuinely touched the list', () => {
    const landing = startMessageSourceLanding('msg-1');
    expect(
      canSettleMessageSourceLanding(landing, { ...context, abandoned: true }),
    ).toBe(false);
  });

  it('refuses once a different message owns the anchor', () => {
    const landing = startMessageSourceLanding('msg-1');
    expect(
      canSettleMessageSourceLanding(landing, { ...context, messageAnchorId: 'msg-2' }),
    ).toBe(false);
  });

  it('refuses once the landing has already settled', () => {
    const landing = startMessageSourceLanding('msg-1');
    landing.settled = true;
    expect(canSettleMessageSourceLanding(landing, context)).toBe(false);
  });

  it('a fresh jump to a new message starts its own landing, independent of a stale one', () => {
    const first = startMessageSourceLanding('msg-1');
    const second = startMessageSourceLanding('msg-2');
    // The reader jumped again before the first landing settled. The stale
    // landing must not settle against the new anchor, and the new landing
    // must settle on its own.
    expect(canSettleMessageSourceLanding(first, { ...context, messageAnchorId: 'msg-2' })).toBe(false);
    expect(canSettleMessageSourceLanding(second, { ...context, messageAnchorId: 'msg-2' })).toBe(true);
  });
});

describe('shouldSettleMessageSourceLanding', () => {
  const context = {
    messageAnchorId: 'msg-1',
    abandoned: false,
  };

  it('regression: a distant target does not settle before it is actually visible', () => {
    // This is the exact bug a fixed animation-frame or wall-clock delay
    // reintroduced: for a target FlatList has not rendered yet,
    // onScrollToIndexFailed's own scrollToOffset + retry loop is what
    // eventually brings it into range (this can take several viewability
    // reports for a genuinely distant row, each still NOT containing the
    // target while retries are in flight). Settling — or flashing — on any
    // of those earlier reports would act on a still-off-window row.
    const landing = startMessageSourceLanding('msg-1');
    const reportsBeforeArrival = [
      new Set(['msg-40', 'msg-41', 'msg-42']),
      new Set(['msg-38', 'msg-39', 'msg-40']),
      new Set(['msg-20', 'msg-21', 'msg-22']),
    ];
    for (const visibleMessageIds of reportsBeforeArrival) {
      expect(
        shouldSettleMessageSourceLanding(landing, { ...context, visibleMessageIds }),
      ).toBe(false);
      expect(landing.settled).toBe(false);
    }
  });

  it('settles on the first viewability report that actually contains the target', () => {
    const landing = startMessageSourceLanding('msg-1');
    const visibleMessageIds = new Set(['msg-1', 'msg-2']);
    expect(
      shouldSettleMessageSourceLanding(landing, { ...context, visibleMessageIds }),
    ).toBe(true);
  });

  it('settles immediately when the initial jump already landed accurately', () => {
    // The common case: a nearby target FlatList already had measured, so
    // the very first viewability report after the initial scrollToIndex
    // already contains it — no distant-row retry loop was ever needed.
    const landing = startMessageSourceLanding('msg-1');
    expect(
      shouldSettleMessageSourceLanding(landing, {
        ...context,
        visibleMessageIds: new Set(['msg-1']),
      }),
    ).toBe(true);
  });

  it('never settles a second time for the same landing once it has (latched via `settled`)', () => {
    const landing = startMessageSourceLanding('msg-1');
    const visibleMessageIds = new Set(['msg-1']);
    expect(shouldSettleMessageSourceLanding(landing, { ...context, visibleMessageIds })).toBe(true);
    landing.settled = true;
    // A later report still containing the target (e.g. the reader lingers,
    // or an unrelated row's layout change triggers another viewability
    // recompute) must not re-fire the correction or the flash.
    expect(shouldSettleMessageSourceLanding(landing, { ...context, visibleMessageIds })).toBe(false);
  });

  it('regression: a distant target settling through several onScrollToIndexFailed retries is not mistaken for reader abandonment', () => {
    // onScrollToIndexFailed's own corrective scrollToOffset calls provoke
    // native onMomentumScrollBegin/End on the underlying scroll view just
    // like a real gesture would. If that shared signal were used here, a
    // distant target requiring several retries would look identical to a
    // reader who grabbed the list and scrolled away, and would never
    // settle. `abandoned` must stay false through that — it is driven only
    // by a genuine touch (`onScrollBeginDrag`), never by programmatic
    // scrolling — so the landing still settles once the target arrives.
    const landing = startMessageSourceLanding('msg-1');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(
        shouldSettleMessageSourceLanding(landing, {
          ...context,
          abandoned: false,
          visibleMessageIds: new Set([`msg-${40 - attempt}`]),
        }),
      ).toBe(false);
    }
    expect(
      shouldSettleMessageSourceLanding(landing, {
        ...context,
        abandoned: false,
        visibleMessageIds: new Set(['msg-1']),
      }),
    ).toBe(true);
  });

  it('never settles once the reader has genuinely touched the list, even if the target is reported visible', () => {
    const landing = startMessageSourceLanding('msg-1');
    expect(
      shouldSettleMessageSourceLanding(landing, {
        ...context,
        abandoned: true,
        visibleMessageIds: new Set(['msg-1']),
      }),
    ).toBe(false);
  });

  it('abandons a landing once the reader navigates to a different anchor mid-flight', () => {
    const landing = startMessageSourceLanding('msg-1');
    // A second jump before the first settled: new anchor.
    expect(
      shouldSettleMessageSourceLanding(landing, {
        messageAnchorId: 'msg-2',
        abandoned: false,
        visibleMessageIds: new Set(['msg-1', 'msg-2']),
      }),
    ).toBe(false);
  });
});
