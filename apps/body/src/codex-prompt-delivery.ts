import { createHash } from 'node:crypto';

// Task, transcript, resume, review and lifecycle instructions remain per-turn.
const CACHED = new Set(['turn.session', 'turn.members', 'turn.memory', 'turn.corners',
  'turn.workspace-core', 'turn.objective', 'turn.rename', 'turn.brief', 'turn.checkout', 'turn.capabilities']);
export interface DeliveryEntry { readonly id: string; readonly text: string }
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** One confirmed harness conversation, never persisted across an uncertain load.
 * Assembly stages hashes; only a successful delivery commits them. Compaction
 * invalidates even an in-flight stage, so the next turn restores every block. */
export class CodexPromptDelivery {
  private hashes = new Map<string, string>();
  private pending?: Map<string, string>;

  constructor(instructions?: string) {
    if (instructions) this.hashes.set('turn.session', hash(instructions.trim()));
  }

  select(entries: readonly DeliveryEntry[]): DeliveryEntry[] {
    const next = new Map<string, string>();
    const selected: DeliveryEntry[] = [];
    for (const entry of entries) {
      if (!CACHED.has(entry.id)) { selected.push(entry); continue; }
      const digest = hash(entry.text);
      next.set(entry.id, digest);
      if (this.hashes.get(entry.id) !== digest) selected.push(entry);
    }
    for (const id of this.hashes.keys()) {
      if (!next.has(id)) selected.push({ id, text: `${id}: now empty; replaces the previous block.` });
    }
    this.pending = next;
    return selected;
  }

  complete(success: boolean): void {
    if (success && this.pending) this.hashes = this.pending;
    else if (!success) this.hashes.clear();
    this.pending = undefined;
  }

  invalidate(): void { this.hashes.clear(); this.pending = undefined; }
}
