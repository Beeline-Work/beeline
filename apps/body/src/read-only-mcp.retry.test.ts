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
  it.each([false,true])('recovers a safe read after transient network failure (coded=%s)',async coded=>{
    const fetched=vi.fn().mockRejectedValueOnce(coded?new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}}):bareFetchFailed()).mockResolvedValue(Response.json({rooms:[]}));
    vi.stubGlobal('fetch',fetched);
    await callAgentTool('read',{facet:'addresses'},'call-1');
    expect(fetched).toHaveBeenCalledTimes(2);
    expect(fetched.mock.calls[0]?.[1]?.body).toBe(fetched.mock.calls[1]?.[1]?.body);
  });
  it('recovers safe reads from temporary server overload',async()=>{
    const fetched=vi.fn().mockResolvedValueOnce(Response.json({error:'busy'},{status:503})).mockResolvedValue(Response.json({rooms:[]}));
    vi.stubGlobal('fetch',fetched);await callAgentTool('read',{facet:'addresses'},'call-1');expect(fetched).toHaveBeenCalledTimes(2);
  });
  it('bounds failed read recovery and leaves an uncertain write single-attempt',async()=>{
    vi.useFakeTimers();try{
      const fetched=vi.fn(async()=>{throw bareFetchFailed();});vi.stubGlobal('fetch',fetched);
      const result=callAgentTool('read',{facet:'addresses'},'call-1').catch(error=>error);
      await vi.advanceTimersByTimeAsync(10_000);expect((await result).message).toContain('failed before');expect(fetched).toHaveBeenCalledTimes(4);
    }finally{vi.useRealTimers();}
  });

  it('never retries a permanent server refusal', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(callAgentTool('read', { facet:'addresses' }, 'call-1')).rejects.toThrow(
      'daemon operation listRooms failed (403: boom)',
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
