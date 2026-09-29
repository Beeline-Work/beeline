/**
 * Jumping to a message from somewhere else in the app (a quoted reply's
 * reference line, a forward's source, a push notification target) lands
 * `scrollToIndex` on an ESTIMATE: a variable-height row FlatList has not
 * rendered yet is positioned by `averageItemLength`, not its real height.
 * Once that row mounts and native measures it, the same durable id can need
 * centering again.
 *
 * The prior implementation re-issued that correction on a fixed wall-clock
 * schedule (400ms, then 1200ms) no matter whether the first landing already
 * needed one. Firing on the clock instead of on an actual re-layout signal
 * produced two extra, humanly-visible corrections after every jump — the
 * reported wobble — spread far enough apart in time to read as the
 * transcript bouncing rather than settling.
 *
 * A message-source landing instead gets exactly ONE deferred, gated
 * re-center (see `_chat-surface.tsx`, scheduled two animation frames after
 * the initial jump so the check runs once that one layout pass has
 * committed). `canSettleMessageSourceLanding` is the gate: it is `true` at
 * most once per landing, and only while nothing has invalidated it.
 */
export type MessageSourceLanding = {
  messageId: string;
  /** `dragEndSequenceRef` snapshot at landing start. */
  dragSequence: number;
};

export function startMessageSourceLanding(
  messageId: string,
  dragSequence: number,
): MessageSourceLanding {
  return { messageId, dragSequence };
}

/**
 * Whether the one deferred re-center for this landing may still run.
 * `false` once a different message now owns the anchor, the drag sequence
 * has advanced (the reader touched the list, or navigated again before the
 * deferred check fired), or a gesture is in progress — in every case,
 * correcting now would fight something newer than the jump that scheduled
 * it, not finish it.
 */
export function canSettleMessageSourceLanding(
  landing: MessageSourceLanding | null,
  {
    messageAnchorId,
    dragSequence,
    isUserDragging,
  }: {
    messageAnchorId: string | null;
    dragSequence: number;
    isUserDragging: boolean;
  },
): landing is MessageSourceLanding {
  if (!landing) return false;
  if (isUserDragging) return false;
  if (landing.dragSequence !== dragSequence) return false;
  if (landing.messageId !== (messageAnchorId ?? '').trim()) return false;
  return true;
}
