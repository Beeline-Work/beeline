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
  readonly inputTokens?: number;
  readonly totalInputTokens?: number;
  readonly modelCalls: number;
  readonly modelCallsWithoutUsage: number;
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

type UsageInput = { agentEnv: Record<string, string>; sessionId: string };
type UsageCall = { inputTokens?: number; model?: string };

async function readUsageCalls(
  input: UsageInput,
  latestTurn: boolean,
): Promise<UsageCall[] | undefined> {
  const file = await piSessionFilePath(input.agentEnv, input.sessionId);
  // A session may not create its JSONL file until its first prompt.
  if (!file) return latestTurn ? undefined : [];
  const raw = await readFile(file, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  const calls: UsageCall[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let entry: { type?: unknown; message?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'message' || !entry.message) continue;
    if (entry.message.role === 'user' && latestTurn) calls.length = 0;
    if (entry.message.role !== 'assistant') continue;
    const usage = entry.message.usage;
    const tokens =
      usage && typeof usage === 'object' && !Array.isArray(usage)
        ? promptTokens(usage as Record<string, unknown>)
        : undefined;
    const model = entry.message.model;
    calls.push({
      ...(tokens !== undefined ? { inputTokens: tokens } : {}),
      ...(typeof model === 'string' && model ? { model } : {}),
    });
  }
  return calls;
}

function summarize(calls: readonly UsageCall[]): HarnessTurnUsage | undefined {
  if (!calls.length) return undefined;
  const measured = calls.filter((call) => call.inputTokens !== undefined);
  return {
    ...calls[calls.length - 1],
    ...(measured.length
      ? { totalInputTokens: measured.reduce((sum, call) => sum + call.inputTokens!, 0) }
      : {}),
    modelCalls: measured.length,
    modelCallsWithoutUsage: calls.length - measured.length,
  };
}

/** Final-call prompt tokens and real usage totals since the last user message. */
export async function readHarnessTurnUsage(
  input: UsageInput,
): Promise<HarnessTurnUsage | undefined> {
  const calls = await readUsageCalls(input, true);
  return calls ? summarize(calls) : undefined;
}

/** Counts newly recorded calls around each prompt, including repair and retry sessions. */
export class TurnUsageAccumulator {
  private readonly calls: UsageCall[] = [];

  async measure<T>(input: UsageInput, run: () => Promise<T>): Promise<T> {
    const before = await readUsageCalls(input, false);
    try {
      return await run();
    } finally {
      const after = await readUsageCalls(input, false);
      // Without a baseline, history cannot safely be attributed to this turn.
      if (before && after) this.calls.push(...after.slice(before.length));
    }
  }

  get usage(): HarnessTurnUsage | undefined {
    return summarize(this.calls);
  }
}
