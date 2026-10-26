/** Content-free, bounded diagnostics carried by the existing terminal receipt. */
export interface ReplayToolCall {
  name: string;
  outcome: 'ok' | 'refused' | 'error' | 'unfinished';
  durationMs: number;
  error?: string;
}
export interface TurnReplay {
  totalMs: number;
  attempts: { attempt: number; phases: Record<string, number>; tools: ReplayToolCall[] }[];
}

/** Redact before truncating so a cut token cannot escape detection. */
export function redactReplayError(value: string): string {
  return value
    .replace(/(["']?)\b(?:token|secret|password|api[_-]?key|authorization|cookie)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi, '[SECRET]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|secret|password|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+)/gi, '[SECRET]')
    .replace(/\b[A-Za-z0-9_+\/-]{24,}(?:\.[A-Za-z0-9_+\/-]+)*={0,2}/g, '[TOKEN]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, '[TOKEN]')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** ACP titles can contain command lines: never persist a descriptive title. */
export function replayToolName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(value)
    && !/^(?:sk-|gh[pousr]_|github_pat_)/.test(value) ? value : 'unknown';
}
const PHASES = ['queue-wait', 'activation', 'context-fetch', 'first-model-output', 'model-stream', 'tool-work', 'publish'];
const duration = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? Math.min(value, 604_800_000) : 0;

/** Whitelist again at the server boundary; arguments, outputs and extra keys never survive. */
export function sanitizeTurnReplay(input: unknown): TurnReplay | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as TurnReplay;
  if (!Array.isArray(record.attempts) || record.attempts.length > 20) return undefined;
  return {
    totalMs: duration(record.totalMs),
    attempts: record.attempts.map((entry, index) => ({
      attempt: index + 1,
      phases: Object.fromEntries(PHASES.filter(key => entry?.phases && typeof entry.phases[key] === 'number')
        .map(key => [key, duration(entry.phases[key])])),
      tools: (Array.isArray(entry?.tools) ? entry.tools.slice(0, 2000) : []).map(tool => ({
        name: replayToolName(tool?.name),
        outcome: (['ok', 'refused', 'error', 'unfinished'] as const).find(value => value === tool?.outcome) ?? 'unfinished',
        durationMs: duration(tool?.durationMs),
        ...(typeof tool?.error === 'string' ? { error: redactReplayError(tool.error) } : {}),
      })),
    })),
  };
}
