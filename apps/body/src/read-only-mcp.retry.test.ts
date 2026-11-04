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
    expect(daemonOperationIsSafeToRepeat('listAgentSubscriptions', {})).toBe(true);
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
  it.each([false,true])('sends one read attempt even for a transient network failure (coded=%s)',async coded=>{
    const fetched=vi.fn(async()=>{throw coded?new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}}):bareFetchFailed();});
    vi.stubGlobal('fetch',fetched);
    await expect(callAgentTool('read',{facet:'addresses'},'call-1')).rejects.toThrow('await a new action or recovery boundary');
    expect(fetched).toHaveBeenCalledTimes(1);
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
    await expect(callAgentTool('read', { facet:'addresses' }, 'call-1')).rejects.toThrow(
      'daemon operation listRooms failed (500: boom)',
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
    await expect(callAgentTool('close_corner', { address:'corner-1' }, 'call-1')).rejects.toThrow(
      'daemon operation archiveCorner failed before the server answered; await a new action or recovery boundary; the write outcome is unknown',
    );
    expect(calls).toBe(1);
  });
});
