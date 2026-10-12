/** Read-only pi session discovery and account-owned OpenRouter generation facts. */
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { writePrivateFileAtomically } from './atomic-private-file.js';

export const OPENROUTER_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const OPENROUTER_GENERATION_URL = 'https://openrouter.ai/api/v1/generation';

export interface OpenRouterGenerationObservation {
  id: string;
  timestamp: number;
  provider: string;
  promptTokens: number;
  cachedTokens: number;
  sessionId?: string;
}

export interface OpenRouterProviderTraffic {
  provider: string;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  cacheShare: number;
}

export function openRouterTraffic(observations: readonly OpenRouterGenerationObservation[]): OpenRouterProviderTraffic[] {
  const totals = new Map<string, { calls: number; promptTokens: number; cachedTokens: number }>();
  for (const observation of observations) {
    if (observation.promptTokens <= 0) continue;
    const total = totals.get(observation.provider) ?? { calls: 0, promptTokens: 0, cachedTokens: 0 };
    total.calls++;
    total.promptTokens += observation.promptTokens;
    total.cachedTokens += Math.min(observation.promptTokens, Math.max(0, observation.cachedTokens));
    totals.set(observation.provider, total);
  }
  return [...totals].map(([provider, total]) => ({ ...total, provider, cacheShare: total.cachedTokens / total.promptTokens }));
}

/** Only ordinary directories beneath this agent's Room homes, never other agents or links. */
async function directories(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name));
}

export async function openRouterGenerationIds(roomsDir: string, model: string, now: number): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const room of await directories(roomsDir)) {
    const ordinary = await Promise.all(['agent-home', 'agent-home/pi', 'agent-home/pi/sessions'].map(async (path) => {
      const stat = await lstat(resolve(room, path)).catch(() => undefined);
      return stat?.isDirectory() && !stat.isSymbolicLink();
    }));
    if (!ordinary.every(Boolean)) continue;
    for (const project of await directories(resolve(room, 'agent-home/pi/sessions'))) {
      const files = await readdir(project, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const stream = createReadStream(resolve(project, file.name), { encoding: 'utf8' });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            try {
              const { message } = JSON.parse(line);
              if (message?.role !== 'assistant' || message.model !== model || typeof message.responseId !== 'string') continue;
              const timestamp = message.timestamp;
              if (typeof timestamp === 'number' && timestamp >= now - OPENROUTER_HISTORY_WINDOW_MS && timestamp <= now) {
                ids.set(message.responseId, timestamp);
              }
            } catch { /* A final in-progress JSONL line is not a failed history read. */ }
          }
        } catch { /* One unreadable session fails alone. */ }
        finally { lines.close(); stream.destroy(); }
      }
    }
  }
  return ids;
}

function observation(value: unknown): OpenRouterGenerationObservation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Partial<OpenRouterGenerationObservation>;
  if (typeof row.id !== 'string' || typeof row.provider !== 'string' ||
      typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp) ||
      typeof row.promptTokens !== 'number' || !Number.isFinite(row.promptTokens) || row.promptTokens < 0 ||
      typeof row.cachedTokens !== 'number' || !Number.isFinite(row.cachedTokens) || row.cachedTokens < 0) return undefined;
  return { id: row.id, provider: row.provider, timestamp: row.timestamp,
    promptTokens: row.promptTokens, cachedTokens: Math.min(row.cachedTokens, row.promptTokens),
    ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}) };
}

/** Successful generation lookups are immutable and fetched once, then aged out after seven days. */
export async function readOpenRouterTraffic(input: {
  model: string;
  roomsDir?: string;
  cacheDir: string;
  apiKey: string;
  now: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OpenRouterProviderTraffic[]> {
  const path = resolve(input.cacheDir, `${input.model.replace(/[^A-Za-z0-9._-]+/g, '_')}.generations.json`);
  let cached: OpenRouterGenerationObservation[] = [];
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    const record = value as { model?: unknown; observations?: unknown } | null;
    if (record?.model === input.model && Array.isArray(record.observations)) {
      cached = record.observations.map(observation).filter((row): row is OpenRouterGenerationObservation => Boolean(row));
    }
  } catch { /* No history yet. */ }
  const cutoff = input.now - OPENROUTER_HISTORY_WINDOW_MS;
  const records = new Map(cached.filter((row) => row.timestamp >= cutoff && row.timestamp <= input.now).map((row) => [row.id, row]));
  const ids = input.roomsDir ? await openRouterGenerationIds(input.roomsDir, input.model, input.now) : new Map<string, number>();
  const missing = [...ids].filter(([id]) => !records.has(id));
  let cursor = 0;
  // Small read concurrency; these GETs do not purchase completions.
  await Promise.all(Array.from({ length: Math.min(6, missing.length) }, async () => {
    while (cursor < missing.length) {
      const [id, timestamp] = missing[cursor++]!;
      try {
        const response = await (input.fetchImpl ?? fetch)(`${OPENROUTER_GENERATION_URL}?id=${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${input.apiKey}` },
          signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
        });
        if (!response.ok) continue;
        const { data } = await response.json() as { data?: Record<string, unknown> };
        if (!data || data.id !== id) continue;
        const row = observation({ id, timestamp, provider: data.provider_name,
          promptTokens: data.native_tokens_prompt, cachedTokens: data.native_tokens_cached ?? 0,
          sessionId: data.session_id });
        if (row) records.set(id, row);
      } catch { /* A missing generation fails alone; unknown providers use the median share. */ }
    }
  }));
  await writePrivateFileAtomically(path, `${JSON.stringify({ model: input.model, observations: [...records.values()] })}\n`).catch(() => undefined);
  return openRouterTraffic([...records.values()]);
}
