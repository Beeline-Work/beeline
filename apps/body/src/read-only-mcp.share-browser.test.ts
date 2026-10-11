import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

const SECRET = 'sk-live-FAKESECRET0123456789';

function squireError(code: string, message: string) {
  return Response.json({ result: {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  } });
}

async function share(): Promise<Error | undefined> {
  return callAgentTool('share_browser', { source: 'squire', sessionId: 'session-1' }, 'call-1')
    .then(() => undefined, (failure: Error) => failure);
}

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
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://beeline.test');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(contextDir, { recursive: true, force: true });
  });

  it('tells the agent to start a new session when the session expired', async () => {
    vi.stubGlobal('fetch', async () => squireError('stale_lease', `Session is not owned ${SECRET}`));

    const error = await share();
    expect(error?.message).toContain('call operate_start for a fresh session');
    expect(error?.message).toContain('(stale_lease)');
    expect(error?.message).not.toContain(SECRET);
  });

  it('maps an unknown Squire session to the same recovery', async () => {
    vi.stubGlobal('fetch', async () => squireError('unknown_session', `${SECRET}. Do not replay mutations.`));

    const error = await share();
    expect(error?.message).toContain('call operate_start');
    expect(error?.message).not.toContain(SECRET);
  });

  it('reports a relay authorization refusal', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }));
    expect((await share())?.message).toBe('Squire relay refused authorization (HTTP 403); this turn may have ended');

    vi.stubGlobal('fetch', async () => Response.json({ error: 'Squire call is not authorized for this task' }, { status: 400 }));
    expect((await share())?.message).toBe('Squire could not share this browser session: Squire call is not authorized for this task');
  });

  it('keeps the HTTP status for an unknown structured cause without its text', async () => {
    vi.stubGlobal('fetch', async () => squireError('tool_execution_failed', `token ${SECRET} leaked`));

    const error = await share();
    expect(error?.message).toBe('Squire share failed (HTTP 200, code tool_execution_failed)');
  });

  it('keeps the HTTP status for a relay error that is not a known refusal', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: `Squire said ${SECRET}` }, { status: 400 }));

    const error = await share();
    expect(error?.message).toBe('Squire share failed (HTTP 400)');
  });

  it('keeps the HTTP status for a non-JSON error body', async () => {
    vi.stubGlobal('fetch', async () => new Response(`<html>${SECRET}</html>`, { status: 502 }));

    const error = await share();
    expect(error?.message).toBe('Squire share failed (HTTP 502)');
  });

  it('does not pass through unstructured Squire error text', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ result: {
      isError: true, content: [{ type: 'text', text: `operate_share failed: ${SECRET}` }],
    } }));

    const error = await share();
    expect(error?.message).toBe('Squire share failed (HTTP 200)');
  });

  it('reports a malformed success response', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ result: {
      content: [{ type: 'text', text: `not json ${SECRET}` }],
    } }));

    const error = await share();
    expect(error?.message).toBe('Squire share returned a malformed response');
  });

  it('reports a timeout', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    expect((await share())?.message).toBe('Squire share timed out after 30 seconds');
  });

  it('keeps the HTTP status when an error body has a malformed envelope', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ result: { content: {} } }, { status: 502 }));

    expect((await share())?.message).toBe('Squire share failed (HTTP 502)');
  });

  it('reports a malformed success envelope', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ result: { content: {} } }));

    expect((await share())?.message).toBe('Squire share returned a malformed response');
  });

  it('reports a timeout while reading the response body', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    }));

    expect((await share())?.message).toBe('Squire share timed out after 30 seconds');
  });

  it('sends the share expiry with the card', async () => {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      if (String(url).startsWith('http://squire.test')) return Response.json({ result: { content: [{
        type: 'text', text: JSON.stringify({ url: `https://squire.test/s/${'a'.repeat(43)}/`, expires_at: expiresAt }),
      }] } });
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: 'card-1', url: 'https://server.test/s/card-1/' });
    });

    const result = JSON.parse(await callAgentTool('share_browser', { source: 'squire', sessionId: 'session-1' }, 'call-1') as string);
    expect(result).toMatchObject({ cardId: 'card-1', status: 'live' });
    expect(posted[0]).toMatchObject({ sessionId: 'session-1', expiresAt: Date.parse(expiresAt) });
  });
});
