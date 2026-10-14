import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SESSION_IDLE_MS } from './session-scheduler.js';

/**
 * A warm ACP session still holds every transcript row an earlier turn in that
 * same session was already prompted with, completed task and steer messages,
 * and every reply it wrote itself, so
 * replaying them costs tokens and made old rows read as new. This is the ONE
 * place that decides what a prompt may leave out.
 *
 *  - the memory belongs to ONE harness session id. Native load preserves it
 *    across helper restarts; a fresh session (including an expired idle lease
 *    or C92 provider re-pin) replays the whole window. Prompts are therefore
 *    built per ATTEMPT, never once per turn.
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
  private fingerprint?: string;
  private usedAt = 0;

  /** Only native-resumable harnesses supply a private, per-surface path. */
  constructor(private readonly options: { path?: string; now?: () => number } = {}) {
    if (!options.path) return;
    try {
      const record = JSON.parse(readFileSync(options.path, 'utf8'));
      if (record.version !== 1 || typeof record.sessionId !== 'string' ||
          typeof record.fingerprint !== 'string' || !Number.isFinite(record.usedAt) ||
          !Array.isArray(record.delivered) || record.delivered.some((id: unknown) => typeof id !== 'string')) return;
      this.sessionId = record.sessionId;
      this.fingerprint = record.fingerprint;
      this.usedAt = record.usedAt;
      for (const id of record.delivered) this.delivered.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[body] transcript memory unreadable; starting cold:', error);
    }
  }

  /** Resume only the matching conversation while the existing idle lease remains valid. */
  resumeSessionId(fingerprint: string): string | undefined {
    const age = this.now() - this.usedAt;
    return this.fingerprint === fingerprint && age >= 0 && age < DEFAULT_SESSION_IDLE_MS
      ? this.sessionId : undefined;
  }

  rememberSession(sessionId: string, fingerprint: string): void {
    if (sessionId !== this.sessionId) this.delivered.clear();
    this.sessionId = sessionId;
    this.fingerprint = fingerprint;
    this.persist();
  }

  /** Poisoned or replaced conversations must never be loaded by a successor. */
  forgetSession(): void {
    this.sessionId = undefined;
    this.fingerprint = undefined;
    this.delivered.clear();
    this.persist();
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private persist(): void {
    this.usedAt = this.now();
    if (!this.options.path) return;
    const directory = dirname(this.options.path);
    const temporary = `${this.options.path}.${process.pid}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, sessionId: this.sessionId,
        fingerprint: this.fingerprint, usedAt: this.usedAt, delivered: [...this.delivered] }), { mode: 0o600 });
      const file = openSync(temporary, 'r');
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, this.options.path);
      const parent = openSync(directory, 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch (error) {
      console.warn('[body] transcript memory could not be persisted:', error);
    }
  }

  /** Completed task and steer messages were delivered outside the transcript. */
  complete(sessionId: string | undefined, messageIds: readonly string[]): void {
    if (!sessionId || sessionId !== this.sessionId) return;
    for (const id of messageIds) this.delivered.add(id);
    this.persist();
  }

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
      this.fingerprint = undefined;
      this.delivered.clear();
    }
    const warm = this.delivered.size > 0;
    const selected = warm
      ? rows.filter((row) => !this.delivered.has(row.id) && !(selfId && row.authorId === selfId))
      : rows;
    for (const row of rows) this.delivered.add(row.id);
    this.persist();
    return { rows: selected, elided: rows.length - selected.length, warm };
  }
}
