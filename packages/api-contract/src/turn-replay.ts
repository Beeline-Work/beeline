/** Content-free, bounded diagnostics carried by the existing terminal receipt. */
export interface ReplayToolCall {
  name: string;
  outcome: 'ok' | 'refused' | 'error' | 'unfinished';
  durationMs: number;
  outputBytes?: number;
  error?: string;
}
export interface TurnReplay {
  reason?: string;
  reasonKind?: string;
  totalMs: number;
  attempts: { attempt: number; phases: Record<string, number>; tools: ReplayToolCall[] }[];
}

/** Match tool identity, never credential-shaped content. */
export function isCredentialFetchToolName(value: unknown): boolean {
  return typeof value === 'string' && /(?:^|[._:/-])fetch_credential$/.test(value);
}

/** Bound diagnostic text without scanning its contents. */
export function redactReplayError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** ACP titles can contain command lines: never persist a descriptive title. */
export function replayToolName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(value) ? value : 'unknown';
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
    ...(typeof record.reason === 'string' ? { reason: redactReplayError(record.reason) } : {}),
    ...(typeof record.reasonKind === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(record.reasonKind)
      ? { reasonKind: record.reasonKind } : {}),
    attempts: record.attempts.map((entry, index) => ({
      attempt: index + 1,
      phases: Object.fromEntries(PHASES.filter(key => entry?.phases && typeof entry.phases[key] === 'number')
        .map(key => [key, duration(entry.phases[key])])),
      tools: (Array.isArray(entry?.tools) ? entry.tools.slice(0, 2000) : []).map(tool => ({
        name: replayToolName(tool?.name),
        outcome: (['ok', 'refused', 'error', 'unfinished'] as const).find(value => value === tool?.outcome) ?? 'unfinished',
        durationMs: duration(tool?.durationMs),
        ...(typeof tool?.outputBytes === 'number' && Number.isSafeInteger(tool.outputBytes) && tool.outputBytes >= 0
          ? { outputBytes: tool.outputBytes } : {}),
        ...(typeof tool?.error === 'string' ? { error: isCredentialFetchToolName(tool.name) ? '[REDACTED]' : redactReplayError(tool.error) } : {}),
      })),
    })),
  };
}
