import { readFile } from 'node:fs/promises';
import { piSessionFilePath } from './pi-turn-record.js';

export async function piCompactionMarker(session: string, env: Record<string, string>): Promise<string | undefined> {
  const file = await piSessionFilePath(env, session);
  if (!file) return undefined;
  try {
    let marker = '';
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === 'compaction') marker = entry.id ?? entry.timestamp;
    }
    return marker;
  } catch { return undefined; }
}

/** Pi ignores ACP systemPrompt. Keep one copy in its conversation, and restore
 * it after a new/repaired conversation, changed rules, or Pi compaction.
 * A missing/unreadable journal never licenses omitting safety instructions. */
export class PiSessionInstructions {
  private readonly sessions = new Map<string, { instructions: string; delivered: boolean; compaction?: string }>();

  remember(session: string, instructions: string): void {
    this.sessions.set(session, { instructions, delivered: false });
  }

  failed(session: string): void {
    const state = this.sessions.get(session);
    if (state) state.delivered = false;
  }

  async prepare(session: string, text: string, env: Record<string, string>): Promise<string> {
    const state = this.sessions.get(session);
    if (!state?.instructions) return text;
    const compaction = await piCompactionMarker(session, env);
    const resend = !state.delivered || compaction === undefined ||
      (state.compaction ?? '') !== compaction;
    const prefix = state.instructions;
    const body = text === prefix ? '' : text.startsWith(`${prefix}\n\n`) ? text.slice(prefix.length + 2) : text;
    state.delivered = true;
    state.compaction = compaction;
    return resend ? [prefix, body].filter(Boolean).join('\n\n') : body;
  }
}
