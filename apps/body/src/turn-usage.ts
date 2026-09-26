/**
 * The real prompt-token cost of the turn that just ended.
 *
 * Beeline never invents a token count. Every harness exposes usage differently
 * and most expose none at all, so this reads what pi itself recorded and returns
 * undefined for everything else — an absent number is "unknown", which the
 * rollout budget gate answers with its byte estimate, while a made-up one would
 * quietly become the measurement.
 *
 * pi's own record is the honest source: one JSONL line per assistant message at
 * `$PI_CODING_AGENT_DIR/sessions/<cwd>/<ts>_<sessionId>.jsonl`, each carrying
 * `usage: {input, cacheRead, cacheWrite, ...}`. The prompt a provider actually
 * billed for is the sum of all three — `input` is only its uncached part, so
 * reading `input` alone would understate a long conversation, where the cache
 * reads dominate, by an order of magnitude.
 */
import { readFile } from 'node:fs/promises';
import { piSessionFilePath } from './pi-turn-record.js';

export interface HarnessTurnUsage {
  /** Prompt tokens of the turn's final model call: input + cache reads + cache writes. */
  readonly inputTokens: number;
  /** The provider/model pi recorded for that call, for the operator's log only. */
  readonly model?: string;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function promptTokens(usage: Record<string, unknown>): number | undefined {
  const input = tokenCount(usage.input) ?? tokenCount(usage.inputTokens);
  if (input === undefined) return undefined;
  const cacheRead = tokenCount(usage.cacheRead) ?? tokenCount(usage.cache_read) ?? 0;
  const cacheWrite = tokenCount(usage.cacheWrite) ?? tokenCount(usage.cache_write) ?? 0;
  return input + cacheRead + cacheWrite;
}

/**
 * Usage of the latest completed model call in a pi session, or undefined when
 * this environment has no pi home, no readable session file, or no usage.
 */
export async function readHarnessTurnUsage(input: {
  agentEnv: Record<string, string>;
  sessionId: string;
}): Promise<HarnessTurnUsage | undefined> {
  const file = await piSessionFilePath(input.agentEnv, input.sessionId);
  if (!file) return undefined;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let latest: HarnessTurnUsage | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as { type?: unknown; message?: Record<string, unknown> };
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    if (entry.message.role === 'user') {
      // A new request starts a new turn: everything before it is history.
      latest = undefined;
      continue;
    }
    if (entry.message.role !== 'assistant') continue;
    const usage = entry.message.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const tokens = promptTokens(usage as Record<string, unknown>);
    if (tokens === undefined) continue;
    const model = entry.message.model;
    latest = {
      inputTokens: tokens,
      ...(typeof model === 'string' && model ? { model } : {}),
    };
  }
  return latest;
}
