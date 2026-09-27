/**
 * A warm ACP session still holds every transcript row an earlier turn in that
 * same session was already prompted with, and every reply it wrote itself, so
 * replaying them costs tokens and made old rows read as new. This is the ONE
 * place that decides what a prompt may leave out.
 *
 *  - the memory belongs to ONE session id. A cold start, a scheduler eviction
 *    and a C92 provider re-pin each produce a different id, and every one of
 *    them replays the whole window — which is why a prompt is built per ATTEMPT
 *    and never once per turn.
 *  - in a warm session only rows it has not seen are sent, and never the
 *    agent's own rows: that session wrote them.
 *  - only the transcript window is ever elided. The session rules, the corner
 *    objective and brief, and the newest message are outside it and always
 *    render.
 */
export type TranscriptRow = {
  /** The message id the row was rendered from; identity for "already sent". */
  readonly id: string;
  readonly line: string;
  readonly authorId?: string;
};

export type TranscriptSelection = {
  readonly rows: readonly TranscriptRow[];
  /** Rows withheld because this exact session already has them. */
  readonly elided: number;
  /** The session already holds earlier rows, so these are only what is new. */
  readonly warm: boolean;
};

export class WarmTranscript {
  private sessionId: string | undefined;
  private readonly delivered = new Set<string>();

  /**
   * The rows this prompt should render. A row counts as delivered once it has
   * been handed to a session: a prompt that times out was still received by the
   * harness, and a prompt that could not be handed over at all takes the
   * session down with it, which resets the memory on the next activation.
   */
  select(
    sessionId: string | undefined,
    rows: readonly TranscriptRow[],
    selfId?: string,
  ): TranscriptSelection {
    if (!sessionId || sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.delivered.clear();
    }
    const warm = this.delivered.size > 0;
    const selected = warm
      ? rows.filter((row) => !this.delivered.has(row.id) && !(selfId && row.authorId === selfId))
      : rows;
    for (const row of rows) this.delivered.add(row.id);
    return { rows: selected, elided: rows.length - selected.length, warm };
  }
}
