/**
 * A warm ACP session still holds every transcript row an earlier turn in that
 * same session was already prompted with, so replaying them costs tokens and
 * buys nothing. This is the ONE place that decides what a prompt may leave out.
 *
 * The rule is deliberately narrow, because the cost of being wrong is an agent
 * that answers without the objective or without a human's hold:
 *
 *  - the memory belongs to ONE session id. A cold start, a scheduler eviction
 *    and a C92 provider re-pin each produce a different id, and every one of
 *    them replays the whole window — which is why a prompt is built per ATTEMPT
 *    and never once per turn.
 *  - the newest `WARM_TRANSCRIPT_OVERLAP` rows are rendered on every prompt, so
 *    a harness that has compacted its own context still sees the live end of
 *    the conversation.
 *  - only the transcript window is ever elided. The turn instructions, the
 *    corner objective and the newest message are outside it and always render.
 */
export const WARM_TRANSCRIPT_OVERLAP = 8;

export type TranscriptRow = {
  /** The message id the row was rendered from; identity for "already sent". */
  readonly id: string;
  readonly line: string;
};

export type TranscriptSelection = {
  readonly rows: readonly TranscriptRow[];
  /** Rows withheld because this exact session was already prompted with them. */
  readonly elided: number;
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
  select(sessionId: string | undefined, rows: readonly TranscriptRow[]): TranscriptSelection {
    if (!sessionId || sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.delivered.clear();
    }
    const overlapFrom = Math.max(0, rows.length - WARM_TRANSCRIPT_OVERLAP);
    const selected = rows.filter(
      (row, index) => index >= overlapFrom || !this.delivered.has(row.id),
    );
    for (const row of rows) this.delivered.add(row.id);
    return { rows: selected, elided: rows.length - selected.length };
  }

  /** Render a selection, and say plainly when it is only what is new. */
  static render(selection: TranscriptSelection, whole: string, sinceLastTurn: string): string {
    const transcript = selection.rows.map((row) => row.line).join('\n');
    if (!transcript) return '';
    return `${selection.elided ? sinceLastTurn : whole}\n${transcript}`;
  }
}
