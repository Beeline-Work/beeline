import { readFile, rm } from 'node:fs/promises';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import type { PromptResult } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';

const normalizeRequest = (request: string): string =>
  request.trim().replace(/^@\S+\s+/, '').toLowerCase().replace(/[.!?]+$/, '');

export interface FreeAgentCheckpoint {
  request: string;
  partial: string;
  tools: string[];
  limits: number;
}

/** Private per-conversation memory, independent of the process killed at the cap. */
export class FreeAgentContinuation {
  private checkpoint?: FreeAgentCheckpoint;
  private request = '';

  constructor(private readonly path?: string) {}

  async begin(request: string): Promise<void> {
    this.request = request.slice(0, 4_000);
    if (this.path) {
      try {
        const saved = JSON.parse(await readFile(this.path, 'utf8'));
        if (saved.version === 1 && typeof saved.request === 'string' && typeof saved.partial === 'string' &&
            Array.isArray(saved.tools) && saved.tools.every((tool: unknown) => typeof tool === 'string') &&
            Number.isSafeInteger(saved.limits) && saved.limits > 0) this.checkpoint = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn('[body] free-agent checkpoint unreadable; starting without it');
      }
    }
    const normalized = normalizeRequest(request);
    if (this.checkpoint && normalized !== normalizeRequest(this.checkpoint.request) &&
        !/^(?:(?:please|yes|ok|okay)[, ]+)?(?:continue|keep going|go on|resume|try again|finish it)(?: please)?$/.test(normalized)) {
      await this.clear();
    }
  }

  get context(): FreeAgentCheckpoint | undefined { return this.checkpoint; }

  async stopped(result: PromptResult): Promise<string> {
    const previous = this.checkpoint;
    this.checkpoint = {
      request: previous?.request ?? this.request,
      partial: [previous?.partial, result.agentText].filter(Boolean).join('\n\n').slice(-8_000),
      tools: [...(previous?.tools ?? []), ...result.toolCalls.map(call =>
        `${redactToolDetail(call.title ?? call.kind ?? 'tool').slice(0, 120)}: ${['completed', 'failed'].includes(call.status ?? '') ? call.status : 'unfinished'}\n${redactToolDetail(JSON.stringify({ input: call.rawInput, output: call.rawOutput ?? call.content }, (key, value) =>
          /token|secret|password|authorization|credential|cookie|api[_-]?key/i.test(key) ? '[REDACTED]' : value) ?? '').slice(0, 500)}`)].slice(-12),
      limits: (previous?.limits ?? 0) + 1,
    };
    if (this.path) await writePrivateFileAtomically(this.path, JSON.stringify({ version: 1, ...this.checkpoint }));
    const note = this.checkpoint.limits < 2
      ? "I've hit the time limit for this turn. I've saved the work so far; send continue to resume it."
      : `I've hit the time limit again. Finishing “${this.checkpoint.request.replace(/\s+/g, ' ').slice(0, 180)}” is too large for one turn. First, I can check ${this.checkpoint.tools.length ? `the output from “${this.checkpoint.tools.at(-1)!.split('\n')[0]!.slice(0, 120)}”` : 'what was finished'} and report one remaining step.`;
    return [result.agentText, note].filter(Boolean).join('\n\n');
  }

  async clear(): Promise<void> {
    if (this.path) await rm(this.path, { force: true });
    this.checkpoint = undefined;
  }
}

export function renderFreeAgentCheckpoint(checkpoint: FreeAgentCheckpoint): string {
  return [
    'Saved work from a turn stopped at the free-agent time limit. The previous process and tools were stopped.',
    'Resume from this checkpoint. Verify unfinished tool results before repeating any action.',
    ...(checkpoint.limits >= 2 ? ['This request hit the limit twice. Explain which remaining part is too large and offer one smaller first step.'] : []),
    `Original request: ${checkpoint.request}`,
    `Work written so far:\n${checkpoint.partial || '(No partial reply was written.)'}`,
    `Observed tool steps (unfinished means no confirmed result):\n${checkpoint.tools.join('\n') || '(No tool steps were observed.)'}`,
  ].join('\n\n');
}
