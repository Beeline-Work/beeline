/**
 * Whether each turn prompt section repeats what the same harness session was
 * last sent, so a trace shows which resent sections actually changed.
 *
 *  - one instance per Room or corner turn runner, so Rooms never share it.
 *  - the baseline belongs to ONE session id; a new id, or `reset()` on a cold
 *    activation, starts over and every section reports `no-baseline`.
 *  - only a sha256 of each section is kept, never its text.
 */
export type PromptSectionChange = 'unchanged' | 'changed' | 'no-baseline';

export class PromptSectionBaseline {
  private sessionId: string | undefined;
  private hashes = new Map<string, string>();

  observe(
    sessionId: string | undefined,
    report: readonly { readonly id: string; readonly hash: string }[],
  ): Record<string, PromptSectionChange> {
    if (!sessionId || sessionId !== this.sessionId) this.reset();
    this.sessionId = sessionId;
    const changes: Record<string, PromptSectionChange> = {};
    for (const { id, hash } of report) {
      const previous = this.hashes.get(id);
      changes[id] = previous === undefined ? 'no-baseline' : previous === hash ? 'unchanged' : 'changed';
    }
    this.hashes = new Map(report.map(({ id, hash }) => [id, hash]));
    return changes;
  }

  reset(): void {
    this.sessionId = undefined;
    this.hashes.clear();
  }
}
