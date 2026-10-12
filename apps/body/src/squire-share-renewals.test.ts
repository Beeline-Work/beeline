import { afterEach, expect, it, vi } from 'vitest';
import type { StdioSquireMcpClient } from './squire-mcp-client.js';
import { SquireShareRenewals, type SquireShareLease } from './squire-share-renewals.js';

const url = `https://squire.test/s/${'a'.repeat(43)}/`;
function result(expiresAt = Date.now() + 1_000) {
  return { content: [{ type: 'text', text: JSON.stringify({ url, expires_at: new Date(expiresAt).toISOString(), control: 'human' }) }] };
}
afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const call = vi.fn(async () => result());
  const client = { requestMcp: call } as unknown as StdioSquireMcpClient;
  const owns = vi.fn(() => true);
  const persist = vi.fn(async (_lease: SquireShareLease) => true);
  const reaped = vi.fn();
  const renewals = new SquireShareRenewals(owns, persist, reaped);
  renewals.track('session', client, result());
  return { renewals, call, client, owns, persist, reaped };
}

it('renews the same human-controlled share over three upstream lifetimes between turns', async () => {
  const { renewals, call, persist, reaped } = fixture();
  await vi.advanceTimersByTimeAsync(3_100);
  expect(call).toHaveBeenCalledTimes(6);
  expect(call).toHaveBeenCalledWith('tools/call', { name: 'operate_share', arguments: { session_id: 'session' } });
  expect(persist).toHaveBeenCalledTimes(6);
  expect(persist.mock.calls.at(-1)?.[0]).toEqual({ sessionId: 'session', upstreamUrl: url, expiresAt: Date.now() + 900 });
  expect(reaped).not.toHaveBeenCalled();
  renewals.close();
});

it('retries a transient provider failure without ending the share', async () => {
  const { renewals, call, persist, reaped } = fixture();
  call.mockRejectedValueOnce(new Error('transport lost'));
  await vi.advanceTimersByTimeAsync(5_600);
  expect(call).toHaveBeenCalledTimes(2);
  expect(persist).toHaveBeenCalledOnce();
  expect(reaped).not.toHaveBeenCalled();
  renewals.close();
});

it('stops maintenance when the Beeline share was explicitly ended', async () => {
  const { renewals, call, persist } = fixture();
  persist.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(call).toHaveBeenCalledOnce();
  renewals.close();
});

it('ends the Beeline share when its owning session is reaped', async () => {
  const { renewals, owns, call, reaped } = fixture();
  owns.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(call).not.toHaveBeenCalled();
  expect(reaped).toHaveBeenCalledOnce();
  expect(reaped).toHaveBeenCalledWith('session');
  renewals.close();
});

it('ignores a renewal response that arrives after the helper stops', async () => {
  const { renewals, call, persist } = fixture();
  let finish!: (value: ReturnType<typeof result>) => void;
  call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(500);
  renewals.close();
  finish(result());
  await vi.advanceTimersByTimeAsync(3_000);
  expect(persist).not.toHaveBeenCalled();
});
