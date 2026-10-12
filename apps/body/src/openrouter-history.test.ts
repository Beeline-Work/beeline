import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OPENROUTER_HISTORY_WINDOW_MS, openRouterGenerationIds, openRouterTraffic, readOpenRouterTraffic } from './openrouter-history.js';

const roots: string[] = [];
const model = 'deepseek/deepseek-v4.1-flash';
const now = 2_000_000_000;
async function scratch() {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-openrouter-history-'));
  roots.push(root); return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function sessions(root: string) {
  const project = resolve(root, 'room/agent-home/pi/sessions/project');
  await mkdir(project, { recursive: true });
  return project;
}
const message = (id: string, timestamp = now, selectedModel = model) => JSON.stringify({
  type: 'message', message: { role: 'assistant', model: selectedModel, responseId: id, timestamp },
});

describe('seven-day OpenRouter traffic', () => {
  it('finds only this model and week, deduplicates response IDs, and tolerates a partial final line', async () => {
    const roomsDir = await scratch(); const project = await sessions(roomsDir);
    await writeFile(resolve(project, 'session.jsonl'), [message('live'), message('live'),
      message('old', now - OPENROUTER_HISTORY_WINDOW_MS - 1), message('future', now + 1),
      message('other', now, 'other/model'), '{partial'].join('\n'));
    expect([...await openRouterGenerationIds(roomsDir, model, now)]).toEqual([['live', now]]);
  });

  it('weights cache reuse by tokens and clamps impossible cache counts', () => {
    expect(openRouterTraffic([
      { id: 'a', timestamp: now, provider: 'Relace', promptTokens: 100, cachedTokens: 100 },
      { id: 'b', timestamp: now, provider: 'Relace', promptTokens: 900, cachedTokens: 0 },
      { id: 'c', timestamp: now, provider: 'Wafer', promptTokens: 10, cachedTokens: 100 },
      { id: 'd', timestamp: now, provider: 'empty', promptTokens: 0, cachedTokens: 0 },
    ])).toEqual([
      { provider: 'Relace', calls: 2, promptTokens: 1000, cachedTokens: 100, cacheShare: .1 },
      { provider: 'Wafer', calls: 1, promptTokens: 10, cachedTokens: 10, cacheShare: 1 },
    ]);
  });

  it('reads generations once, ages out old data, and keeps failed lookups optional', async () => {
    const roomsDir = await scratch(); const cacheDir = await scratch(); const project = await sessions(roomsDir);
    await writeFile(resolve(project, 'session.jsonl'), [message('live'), message('missing')].join('\n'));
    const cacheFile = resolve(cacheDir, 'deepseek_deepseek-v4.1-flash.generations.json');
    await writeFile(cacheFile, JSON.stringify({ model, observations: [{ id: 'old', timestamp: now - OPENROUTER_HISTORY_WINDOW_MS - 1,
      provider: 'Wafer', promptTokens: 100, cachedTokens: 0 }] }));
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      requests.push(String(url)); expect(init?.headers).toEqual({ authorization: 'Bearer test-key' });
      if (String(url).endsWith('missing')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ data: { id: 'live', provider_name: 'Relace', native_tokens_prompt: 100,
        native_tokens_cached: 95, session_id: 'session-id' } }));
    }) as unknown as typeof fetch;
    const input = { model, roomsDir, cacheDir, now, apiKey: 'test-key', fetchImpl };
    const traffic = await readOpenRouterTraffic(input);
    expect(traffic).toEqual([{ provider: 'Relace', calls: 1, promptTokens: 100, cachedTokens: 95, cacheShare: .95 }]);
    expect(JSON.parse(await readFile(cacheFile, 'utf8')).observations).toHaveLength(1);
    await readOpenRouterTraffic(input);
    expect(requests.filter((url) => url.endsWith('live'))).toHaveLength(1);
    expect(requests.filter((url) => url.endsWith('missing'))).toHaveLength(2);
    expect(await readFile(cacheFile, 'utf8')).not.toContain('test-key');
  });

  it('does not cross symlinked Room homes into another agent', async () => {
    const roomsDir = await scratch(); const other = await scratch();
    const project = await sessions(other);
    await writeFile(resolve(project, 'session.jsonl'), message('other-agent'));
    await mkdir(resolve(roomsDir, 'room'));
    await symlink(resolve(other, 'room/agent-home'), resolve(roomsDir, 'room/agent-home'));
    expect([...await openRouterGenerationIds(roomsDir, model, now)]).toEqual([]);
  });
});
