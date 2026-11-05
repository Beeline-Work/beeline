import { describe, expect, it, vi } from 'vitest';
import { AdmissionOwner } from './admission.js';
import { UsageDemandOwner } from './usage-demand-owner.js';
const agentId = 'a'.repeat(64);
function fixture() {
  const admission = new AdmissionOwner({ origin: 'https://synthetic.test', principal: 'reader', sessionEpoch: 1 });
  let current: { generation: number; screen: string; agentId?: string } | null = { generation: 1, screen: 'AgentProfile', agentId };
  const changed = vi.fn(); const owner = new UsageDemandOwner(admission, () => current, changed);
  return { owner, admission, changed, navigate: (next: typeof current) => { current = next; owner.navigationChanged(); } };
}
describe('phone growth and recovery', () => {
  it.each([401, 403, 404, 410])('preserves a terminal server authority denial (%s) without retrying', async status => {
    vi.useFakeTimers();
    const f = fixture(); f.owner.connected(1); f.owner.profile(agentId);
    const error = Object.assign(new Error('authority removed'), { status });
    const send = vi.fn().mockRejectedValue(error);
    try {
      await expect(f.owner.dispatch(agentId, send)).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(1);
    } finally { f.owner.disconnected(); vi.useRealTimers(); }
  });
  it.each([429, 503])('automatically retries a safe usage read and cancels the wait when the profile closes (%s)', async status => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.owner.connected(1); f.owner.profile(agentId);
      const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('temporary'), { status })).mockResolvedValue('current');
      const result = f.owner.dispatch(agentId, send);
      await vi.advanceTimersByTimeAsync(500); expect(await result).toBe('current');
      f.owner.profile(null); f.owner.profile(agentId);
      const offline = vi.fn().mockRejectedValue(new Error('offline'));
      const pending = f.owner.dispatch(agentId, offline).catch(error => error);
      await vi.advanceTimersByTimeAsync(1); f.owner.profile(null);
      expect(await pending).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(60_000); expect(offline).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
