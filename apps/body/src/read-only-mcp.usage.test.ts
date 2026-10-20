import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

describe('read facet usage', () => {
  let home: string;
  let calls: Array<{ name: string; input: Record<string, unknown> }>;
  let usage: unknown;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'beeline-usage-'));
    const context = join(home, 'turn.json');
    writeFileSync(context, JSON.stringify({ roomId: 'room-1', requestId: 'r', generationId: 'g' }));
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-only');
    vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-self');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    calls = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      calls.push({ name, input: JSON.parse(String(init.body)) });
      return Response.json(usage);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const read = async (args: Record<string, unknown> = {}) =>
    JSON.parse(await callAgentTool('read', { facet: 'usage', ...args }, 'call-1'));
  const now = Date.now() / 1000;

  it('reads only the calling agent, even when another address is named', async () => {
    usage = null;
    expect(await read({ address: 'someone-elses-room' })).toEqual({
      summary: 'Usage: unknown (harness reports none).',
    });
    expect(calls).toEqual([{ name: 'getAgentUsage', input: { agentId: 'agent-self' } }]);
  });

  it('returns every Claude window, context and staleness with a summary', async () => {
    usage = {
      updatedAt: now - 1900,
      windows: [
        { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: now + 600, updatedAt: now - 1900 },
        { rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 0.83, resetsAt: now + 86_400 * 3, updatedAt: now - 1900 },
      ],
      context: { used: 612_000, size: 1_000_000 },
    };
    const result = await read();
    expect(result.old).toBe(true);
    expect(result.usage.windows).toHaveLength(2);
    expect(result.summary).toMatch(/^Usage: 5-hour 42% .*weekly 83% .*context 612K of 1M tokens/);
  });

  it('gives free agents tokens and paused state, never money', async () => {
    usage = { updatedAt: now, windows: [], free: { used: 840_000, limit: 1_000_000, resetsAt: now + 3600, paused: true } };
    const text = await callAgentTool('read', { facet: 'usage' }, 'call-2');
    expect(JSON.parse(text).usage.free.paused).toBe(true);
    expect(text).not.toContain('$');
  });

  it('reports OpenRouter key spend as shared', async () => {
    usage = { updatedAt: now, windows: [], spend: { today: 4.12, week: 18.4, limit: 20, remaining: 15.88 } };
    expect((await read()).summary).toContain('$15.88 of $20 key limit left');
    expect((await read()).summary).toContain('shared OpenRouter key');
  });
});
