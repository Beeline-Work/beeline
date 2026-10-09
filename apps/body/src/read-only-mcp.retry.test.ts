import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callAgentTool,
  daemonOperationIsSafeToRepeat,
  isDaemonNetworkFailure,
} from './read-only-mcp.js';

beforeEach(() => {
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: 'room-1',
    BEELINE_DAEMON_BASE_URL: 'http://localhost:1234',
    BEELINE_DAEMON_TOKEN: 'test-token',
  }))
    vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const bareFetchFailed = () => new TypeError('fetch failed');

describe('daemon network-failure classification', () => {
  it('recognises a bare fetch failed and a coded cause, never a server response', () => {
    expect(isDaemonNetworkFailure(bareFetchFailed())).toBe(true);
    expect(
      isDaemonNetworkFailure(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true);
    expect(isDaemonNetworkFailure(new Error('corner not found'))).toBe(false);
  });
});

describe('daemonOperationIsSafeToRepeat', () => {
  it('repeats reads', () => {
    expect(daemonOperationIsSafeToRepeat('getPrChecksStatus', {})).toBe(true);
    expect(daemonOperationIsSafeToRepeat('listRoomWebhooks', {})).toBe(true);
  });

  it('never repeats an ordinary write', () => {
    expect(daemonOperationIsSafeToRepeat('postAgentAttachment', {})).toBe(false);
    expect(daemonOperationIsSafeToRepeat('postRoomMessage', {})).toBe(false);
    expect(daemonOperationIsSafeToRepeat('walletPay', {})).toBe(false);
    expect(daemonOperationIsSafeToRepeat('archiveCorner', {})).toBe(false);
  });

  it('repeats any operation that carries its own idempotency key', () => {
    expect(daemonOperationIsSafeToRepeat('createCorner', { idempotencyKey: 'one' })).toBe(true);
  });
});

describe('daemon tool-call network retry', () => {
  it('retries a read after a bare fetch failed and returns the successful answer', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1) throw bareFetchFailed();
      return Response.json({ sources: [] });
    });
    await expect(callAgentTool('list_webhooks', {}, 'call-1')).resolves.toBe(
      JSON.stringify({ sources: [] }),
    );
    expect(calls).toBe(2);
  });

  it('retries a read whose failure only names the code in its cause chain', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1)
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      return Response.json({ sources: [] });
    });
    await expect(callAgentTool('list_webhooks', {}, 'call-1')).resolves.toBe(
      JSON.stringify({ sources: [] }),
    );
    expect(calls).toBe(2);
  });

  it('gives up after two retries and stops sending', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      throw bareFetchFailed();
    });
    await expect(callAgentTool('list_webhooks', {}, 'call-1')).rejects.toThrow(
      'daemon operation listRoomWebhooks failed with a network error after 3 attempts',
    );
    expect(calls).toBe(3);
  });

  it('never retries a response the server actually sent', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(callAgentTool('list_webhooks', {}, 'call-1')).rejects.toThrow(
      'daemon operation listRoomWebhooks failed (500: boom)',
    );
    expect(calls).toBe(1);
  });

  it('sends a non-idempotent write once and says it may not have run', async () => {
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      throw bareFetchFailed();
    });
    await expect(callAgentTool('close_corner', {}, 'call-1')).rejects.toThrow(
      'daemon operation archiveCorner failed with a network error before the server answered; the call may not have run',
    );
    expect(calls).toBe(1);
  });
});
