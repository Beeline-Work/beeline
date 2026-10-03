/**
 * Jumping to a message from somewhere else in the app (a quoted reply's
 * reference line, a forward's source, a push notification target) lands
 * `scrollToIndex` on an ESTIMATE for any row FlatList hasn't measured yet,
 * and a distant target's preceding rows can still be provisional even when
 * the call itself doesn't fail — the same durable id can need centering
 * again once real layout has actually committed.
 *
 * The prior implementation re-issued that correction on a fixed wall-clock
 * schedule (400ms, then 1200ms) no matter whether the first landing already
 * needed one, or replaced that ladder with a fixed two-animation-frame delay
 * — both guess an amount of time rather than observing whether the target
 * has actually rendered. Guessing raced `onScrollToIndexFailed`'s own
 * measure-and-retry loop for a genuinely distant target (which can take
 * several 100ms retries to bring the row into range) and could re-center —
 * or flash — a row that was still off-window or clipped.
 *
 * `shouldSettleMessageSourceLanding` is the real signal instead: it is
 * `true` only once the reader's OWN viewability report — the same report
 * that already tells `onScrollToIndexFailed` when to stop retrying — says
 * the target id is actually on screen. A distant target therefore settles
 * only after `onScrollToIndexFailed`'s retries have gotten it into view;
 * a target that was already accurate settles on the very next report, with
 * a harmless no-op re-center. Settling is latched via `landing.settled` so
 * a landing acts at most once no matter how many later viewability reports
 * arrive.
 *
 * Abandonment is intentionally NOT `dragEndSequenceRef`/a shared drag-count:
 * `onScrollToIndexFailed`'s own corrective `scrollToOffset` calls provoke
 * `onMomentumScrollBegin`/`End` on the underlying native scroll view exactly
 * like a real gesture would, so a distant target needing several retries
 * advances that shared counter purely from the app's OWN programmatic
 * scrolling — measured live, gating on it would refuse to ever settle a
 * genuinely distant target. `abandoned` must be a signal only a real touch
 * can set (`onScrollBeginDrag`, which never fires for a programmatic
 * `scrollToIndex`/`scrollToOffset`), latched from landing start.
 */
export type MessageSourceLanding = {
  messageId: string;
  /** Set once this landing has acted; every later check refuses. */
  settled: boolean;
};

export function startMessageSourceLanding(messageId: string): MessageSourceLanding {
  return { messageId, settled: false };
}

/**
 * Whether this landing's context is still valid to act on at all — `false`
 * once a different message now owns the anchor, the reader has genuinely
 * touched the list since this landing started, or the landing already
 * settled. This alone says nothing about whether the target is actually
 * visible; see `shouldSettleMessageSourceLanding`.
 */
export function canSettleMessageSourceLanding(
  landing: MessageSourceLanding | null,
  {
    messageAnchorId,
    abandoned,
  }: {
    messageAnchorId: string | null;
    /** True once the reader has genuinely touched the list (`onScrollBeginDrag`) since this landing started. */
    abandoned: boolean;
  },
): landing is MessageSourceLanding {
  if (!landing || landing.settled) return false;
  if (abandoned) return false;
  if (landing.messageId !== (messageAnchorId ?? '').trim()) return false;
  return true;
}

/**
 * The actual settle decision for one viewability report: the landing's
 * context must still be valid (`canSettleMessageSourceLanding`) AND the
 * reader's own viewable-ids report must include the target. Call this on
 * every viewability report; it stays `false` for a distant target through
 * however many reports `onScrollToIndexFailed`'s retries take to land it,
 * and becomes `true` on the first report that actually contains it.
 */
export function shouldSettleMessageSourceLanding(
  landing: MessageSourceLanding | null,
  {
    messageAnchorId,
    abandoned,
    visibleMessageIds,
  }: {
    messageAnchorId: string | null;
    abandoned: boolean;
    visibleMessageIds: ReadonlySet<string>;
  },
): landing is MessageSourceLanding {
  if (!canSettleMessageSourceLanding(landing, { messageAnchorId, abandoned })) {
    return false;
  }
  return visibleMessageIds.has(landing.messageId);
}

export function completeMessageSourceLanding(input: {
  landing: MessageSourceLanding | null;
  messageAnchorId: string | null;
  abandoned: boolean;
  visibleMessageIds: ReadonlySet<string>;
  rows: readonly { id: string; relayId?: string | null }[];
  scrollToIndex: (index: number) => void;
  flash: (messageId: string) => void;
  dismissCover: (messageId: string) => void;
}): boolean {
  const { landing } = input;
  if (!shouldSettleMessageSourceLanding(landing, input)) return false;
  const index = input.rows.findIndex(
    (row) => row.id === landing.messageId || row.relayId === landing.messageId,
  );
  if (index < 0) return false;
  landing.settled = true;
  input.scrollToIndex(index);
  input.flash(landing.messageId);
  input.dismissCover(landing.messageId);
  return true;
}
