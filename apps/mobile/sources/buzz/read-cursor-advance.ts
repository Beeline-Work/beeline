import { messageBoundaryIds } from './room-new-message-boundary';
import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * How long the viewport must hold still before its newest row is published as
 * the read cursor. A scroll reports viewability many times per second and the
 * rows it sweeps past were never read, so the boundary follows where the
 * reader STOPPED, not every row that crossed the fold on the way there.
 */
export const READ_CURSOR_DEBOUNCE_MS = 200;

/** A provisional row is painted from an unsettled turn, not stored mail. */
function isProvisional(
  message: Pick<ChatDisplayMessage, 'isAgentDraft' | 'isAgentLiveTurn' | 'isAgentActivity'>,
): boolean {
  return Boolean(message.isAgentDraft || message.isAgentLiveTurn || message.isAgentActivity);
}

/**
 * Row order is authoritative for ordinary and folded rows. Corner cards alone
 * have moved away from their chronological position: merge them back by the
 * server's (created_at, id) order for read marks, without moving their UI.
 */
function readBoundaries(chronological: readonly ChatDisplayMessage[]) {
  const rows = chronological.filter(message => !isProvisional(message));
  const rowBoundaries = (message: ChatDisplayMessage, hostId: string) =>
    (message.foldedReadBoundaries ?? messageBoundaryIds(message).map(id => ({
      id, orderAtMs: message.orderAtMs ?? message.timestamp * 1_000,
    }))).map(boundary => ({ ...boundary, hostId }));
  type Boundary = ReturnType<typeof rowBoundaries>[number];
  const compare = (left: Boundary, right: Boundary) =>
    left.orderAtMs - right.orderAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const markers = rows.flatMap(host => (host.cornerMarkers ?? [])
    .filter(marker => !isProvisional(marker))
    .flatMap(message => rowBoundaries(message, host.id)))
    .sort(compare);
  const boundaries: Boundary[] = [];
  let nextMarker = 0;
  const appendMarker = () => {
    boundaries.push(markers[nextMarker++]!);
  };
  for (const row of rows) {
    for (const boundary of rowBoundaries(row, row.id)) {
      while (nextMarker < markers.length && compare(markers[nextMarker]!, boundary) < 0) appendMarker();
      boundaries.push(boundary);
    }
  }
  while (nextMarker < markers.length) appendMarker();
  return boundaries;
}

/**
 * Seeing a host credits its anchored cards. Seeing the durable tail credits
 * all preceding content, including a newest card anchored above the viewport.
 * Away from the tail, cards on unseen hosts contribute nothing.
 */
export function newestVisibleMessageId(
  chronological: readonly ChatDisplayMessage[],
  visible: readonly ChatDisplayMessage[],
): string | null {
  const visibleIds = new Set(visible.filter(message => !isProvisional(message)).map(message => message.id));
  const tail = newestCountableMessage(chronological);
  const atTail = tail !== null && visibleIds.has(tail.id);
  return readBoundaries(chronological)
    .filter(boundary => atTail || visibleIds.has(boundary.hostId))
    .at(-1)?.id ?? null;
}

/**
 * The newest durable row in the transcript, provisional turn rows skipped the
 * same way `newestVisibleMessageId` skips them.
 *
 * The viewport's own report is the boundary's usual owner. This is what a
 * surface reports when the newest row CHANGES under a reader already at the
 * tail, where the list may run no new viewability pass: a provisional lane or
 * draft must not be credited, but the durable reply it settles into must.
 */
export function newestCountableMessage(
  chronological: readonly ChatDisplayMessage[],
): ChatDisplayMessage | null {
  for (let index = chronological.length - 1; index >= 0; index -= 1) {
    const message = chronological[index]!;
    if (isProvisional(message)) continue;
    return message;
  }
  return null;
}

/**
 * Evidence the list has actually shown the reader the newest end. A fetched
 * Room view is not evidence: on a cold open the controller's pin starts true
 * and a first-unread landing is still on its way, so an unguarded re-ask would
 * read the fetched tail over messages sitting below the fold.
 */
export type PinnedTailReadEvidence = {
  /** The reader rests at (or within the threshold of) the newest end. */
  readonly pinnedToTail: boolean;
  /** A row request (a first-unread or jump landing) still owns the list. */
  readonly landing: boolean;
  /** The list has reported what is on screen at least once. */
  readonly hasObservedVisibility: boolean;
};

/**
 * The report a surface sends when the newest row changes under a reader
 * already resting at the tail: the newest durable row alone, or nothing when
 * every trailing row is provisional or the evidence is missing.
 *
 * Kept as one function so the surface's pinned-tail re-ask and its behavioral
 * regression make the same decision. The list's own viewability report remains
 * the boundary's normal owner; this is only the re-ask the list does not owe
 * when an arrival leaves the viewable set unchanged. It stays silent until the
 * list has said what is on screen and no landing owns it, so a cold open never
 * reads the fetched tail.
 */
export function pinnedTailReadReport(
  chronological: readonly ChatDisplayMessage[],
  evidence: PinnedTailReadEvidence,
): readonly ChatDisplayMessage[] {
  if (!evidence.hasObservedVisibility || evidence.landing || !evidence.pinnedToTail) return [];
  const newest = newestCountableMessage(chronological);
  return newest ? [newest] : [];
}

/**
 * Coalesces a scroll's worth of viewport reports into one read-cursor write.
 *
 * Every array handed to this advancer is the CHRONOLOGICAL transcript, oldest
 * first — never the reversed array the native inverted list renders from. The
 * forward-only comparison ranks durable boundaries, including anchored cards, so
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
    private readonly readyToPublish: () => boolean = () => true,
  ) {}

  /**
   * One viewability report. A changed boundary restarts the debounce.
   * `chronological` is the oldest-first transcript, never the inverted list.
   */
  observe(
    chronological: readonly ChatDisplayMessage[],
    visible: readonly ChatDisplayMessage[],
  ): void {
    if (this.#suspended) return;
    const candidate = newestVisibleMessageId(chronological, visible);
    if (!candidate || !this.#advances(chronological, candidate)) return;
    // Metadata arriving after draw can repeat the same viewport report. The
    // reader has held that row still; do not postpone its read mark again.
    if (candidate === this.#pending) {
      this.retry();
      return;
    }
    this.#pending = candidate;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /**
   * Publish the pending boundary now. Backgrounding or leaving the Room ends
   * the visit before the debounce would have fired, and what the reader saw is
   * no less read for it.
   */
  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const target = this.#pending;
    if (target === null || !this.readyToPublish()) return;
    this.#pending = null;
    this.#published = target;
    this.publish(target);
  }

  /** A client becoming available must not shorten an active viewport debounce. */
  retry(): void {
    if (this.#timer === null) this.flush();
  }

  /**
   * The mark the server already holds. A viewport that reaches it, and no
   * further, has nothing to write; one that moves past it writes as usual.
   * Never moves a boundary this visit already published.
   */
  seed(messageId: string): void {
    if (this.#published === null) this.#published = messageId;
  }

  /**
   * The server moved the mark here itself (the viewer's own send): the
   * viewport reaching this row has nothing left to write.
   */
  acknowledge(messageId: string): void {
    this.#published = messageId;
    // A queued write for the same row, or an older one, has nothing left to say.
    this.cancel();
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
    const boundaries = readBoundaries(chronological);
    const published = boundaries.findIndex(boundary => boundary.id === this.#published);
    if (published < 0) return true;
    const next = boundaries.findIndex(boundary => boundary.id === candidate);
    return next > published;
  }
}
