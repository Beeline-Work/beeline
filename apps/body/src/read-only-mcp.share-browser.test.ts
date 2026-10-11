import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

describe('share_browser Squire refusal', () => {
  let contextDir: string;

  beforeEach(() => {
    contextDir = mkdtempSync(join(process.cwd(), '.share-browser-test-'));
    const contextFile = join(contextDir, 'turn.json');
    writeFileSync(contextFile, JSON.stringify({
      roomId: 'room-1', requestId: 'request-1', generationId: 'generation-1',
    }));
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', contextFile);
    vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', 'http://squire.test');
    vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(contextDir, { recursive: true, force: true });
  });

  it('passes through a bounded, single-line Squire error', async () => {
    const cause = 'operate_share is unavailable in this Squire installation';
    vi.stubGlobal('fetch', async () => Response.json({ result: {
      isError: true,
      content: [{ type: 'text', text: `  ${cause}\n${'detail '.repeat(100)}  ` }],
    } }));

    const error = await callAgentTool('share_browser', { source: 'squire', sessionId: 'session-1' }, 'call-1')
      .then(() => undefined, (failure: Error) => failure);
    expect(error?.message).toContain(`Squire could not share this browser session: ${cause}`);
    expect(error?.message).not.toContain('\n');
    expect(error?.message.length).toBeLessThanOrEqual(350);
  });

  it('passes through an error on an otherwise empty response', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'operate_share tool is not installed' }));

    await expect(callAgentTool('share_browser', { source: 'squire', sessionId: 'session-1' }, 'call-1'))
      .rejects.toThrow('Squire could not share this browser session: operate_share tool is not installed');
  });

  it('keeps the generic refusal when Squire supplies no text', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ result: {
      isError: true, content: [{ type: 'text', text: ' \n ' }],
    } }));

    const error = await callAgentTool('share_browser', { source: 'squire', sessionId: 'session-1' }, 'call-1')
      .then(() => undefined, (failure: Error) => failure);
    expect(error?.message).toBe('Squire could not share this browser session');
  });
});
