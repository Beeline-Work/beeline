import { messageBoundaryIds } from './room-new-message-boundary';
import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * How long the viewport must hold still before its newest row is published as
 * the read cursor. A scroll reports viewability many times per second and the
 * rows it sweeps past were never read, so the boundary follows where the
 * reader STOPPED, not every row that crossed the fold on the way there.
 */
export const READ_CURSOR_DEBOUNCE_MS = 400;

/**
 * The durable message id the viewport says has been read.
 *
 * A virtualized row may fold several durable messages into one; seeing that
 * row is seeing all of them, so the newest visible row contributes its LAST
 * durable id. Rows are ranked by their position in the transcript rather than
 * by any clock, because the transcript already carries the server's own
 * `(created_at, id)` order and the read mark is compared against exactly that.
 *
 * `chronological` must be the CHRONOLOGICAL order — oldest first — and not the
 * reversed array the native inverted list renders from. Ranking by index is
 * only "newest wins" when the array agrees with the server's ordering; handed
 * the phone's reversed list it picks the oldest visible row and reads a scroll
 * back up the transcript as forward progress. The jump control reads the same
 * order for the same reason (`_chat-surface.tsx`, `newestTranscriptRowId`).
 *
 * `visible` may arrive in any order — it is the list's own viewability report,
 * and only membership is taken from it.
 */
export function newestVisibleMessageId(
  chronological: readonly ChatDisplayMessage[],
  visible: readonly ChatDisplayMessage[],
): string | null {
  let newestIndex = -1;
  for (const message of visible) {
    const index = chronological.findIndex((row) => row.id === message.id);
    if (index > newestIndex) newestIndex = index;
  }
  if (newestIndex < 0) return null;
  return messageBoundaryIds(chronological[newestIndex]!).at(-1) ?? null;
}

/**
 * Coalesces a scroll's worth of viewport reports into one read-cursor write.
 *
 * Every array handed to this advancer is the CHRONOLOGICAL transcript, oldest
 * first — never the reversed array the native inverted list renders from. Both
 * the candidate's selection and the forward-only comparison rank by index, so
 * a reversed array silently inverts both.
 *
 * The boundary only ever moves forward under this advancer: it compares the
 * candidate against the last id it published by their positions in the CURRENT
 * transcript, so loading older history above the reader shifts both and
 * changes nothing. Moving the boundary backwards is mark-unread's job alone,
 * and `suspend()` is how that intent is protected — once the reader has
 * declared something unread, the viewport they are still looking at must not
 * immediately read it again.
 */
export class ReadCursorAdvancer {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: string | null = null;
  #published: string | null = null;
  #suspended = false;

  constructor(
    private readonly publish: (messageId: string) => void,
    private readonly delayMs: number = READ_CURSOR_DEBOUNCE_MS,
  ) {}

  /**
   * One viewability report. Restarts the debounce; publishes nothing yet.
   * `chronological` is the oldest-first transcript, never the inverted list.
   */
  observe(
    chronological: readonly ChatDisplayMessage[],
    visible: readonly ChatDisplayMessage[],
  ): void {
    if (this.#suspended) return;
    const candidate = newestVisibleMessageId(chronological, visible);
    if (!candidate || !this.#advances(chronological, candidate)) return;
    this.#pending = candidate;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const target = this.#pending;
      this.#pending = null;
      if (target === null) return;
      this.#published = target;
      this.publish(target);
    }, this.delayMs);
  }

  /**
   * Publish the pending boundary now. Backgrounding or leaving the Room ends
   * the visit before the debounce would have fired, and what the reader saw is
   * no less read for it.
   */
  flush(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    const target = this.#pending;
    this.#pending = null;
    if (target === null) return;
    this.#published = target;
    this.publish(target);
  }

  /** Stop advancing until `resume()`. Mark-unread's protection. */
  suspend(): void {
    this.#suspended = true;
    this.cancel();
  }

  resume(): void {
    this.#suspended = false;
    this.#published = null;
  }

  /** Drop the pending write without publishing it. */
  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }

  #advances(chronological: readonly ChatDisplayMessage[], candidate: string): boolean {
    if (this.#published === null) return true;
    // A reader sitting still reports the same row many times over. Only a
    // different, later boundary is worth a write.
    if (this.#published === candidate) return false;
    const published = chronological.findIndex((row) =>
      messageBoundaryIds(row).includes(this.#published!),
    );
    if (published < 0) return true;
    const next = chronological.findIndex((row) => messageBoundaryIds(row).includes(candidate));
    return next < 0 || next >= published;
  }
}
