import { describe, expect, it, vi } from 'vitest';
import { AdmissionOwner } from './private/admission.js';
import { UsageDemandOwner } from './private/usage-demand-owner.js';
import { NavigationOwner } from './private/navigation-owner.js';
const agentId = 'a'.repeat(64);
function fixture() {
  const admission = new AdmissionOwner({ origin: 'https://synthetic.test', principal: 'reader', sessionEpoch: 1 });
  let current: { generation: number; screen: string; agentId?: string } | null = { generation: 1, screen: 'AgentProfile', agentId };
  const changed = vi.fn(); const owner = new UsageDemandOwner(admission, () => current, changed);
  return { owner, admission, changed, navigate: (next: typeof current) => { current = next; owner.navigationChanged(); } };
}
describe('committed usage profile demand', () => {
  it('automatically retries a safe usage read and cancels the wait when the profile closes', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.owner.connected(1); f.owner.profile(agentId);
      const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('current');
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
  it('the actual AgentProfile route is recognized and changing agent advances navigation generation', () => {
    const nav = new NavigationOwner();
    const route = (id: string) => ({ routes: [{ key: 'profile', name: 'beeline/agent-profile', params: { agentId: id, communityId: 'workspace' } }] });
    nav.observe(route(agentId)); const first = nav.current(); expect(first).toMatchObject({ screen: 'AgentProfile', agentId });
    nav.observe(route(agentId)); expect(nav.current()).toBe(first);
    nav.observe(route('b'.repeat(64))); expect(nav.current()!.generation).toBeGreaterThan(first!.generation);
  });
  it('one committed selection supplies one exact read; observer/remount repetition cannot remint', async () => {
    const f = fixture(); f.owner.connected(1); f.owner.profile(agentId); const send = vi.fn(async (input: Readonly<{ agentId: string }>) => input);
    expect(f.changed).toHaveBeenCalledWith(agentId);
    await expect(f.owner.dispatch(agentId, send)).resolves.toEqual({ agentId });
    f.owner.profile(agentId);
    await expect(f.owner.dispatch(agentId, send)).rejects.toThrow('not current'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('a committed Room work-pane selection can replace an agent while unrelated AppShell cannot grant reads', async () => {
    const f = fixture(); f.navigate({ generation: 2, screen: 'Room' }); f.owner.connected(1);
    f.owner.profile(agentId); await f.owner.dispatch(agentId, async () => 'first');
    const other = 'b'.repeat(64); f.owner.profile(other);
    await expect(f.owner.dispatch(agentId, async () => 'wrong')).rejects.toThrow('not current');
    await expect(f.owner.dispatch(other, async () => 'second')).resolves.toBe('second');
    f.navigate({ generation: 3, screen: 'AppShell' }); f.owner.profile(agentId);
    await expect(f.owner.dispatch(agentId, async () => 'hidden')).rejects.toThrow('not current');
  });
  it('a real committed close and reopen creates a new profile lifetime in the same Room navigation', async () => {
    const f = fixture(); f.navigate({ generation: 2, screen: 'Room' }); f.owner.connected(1);
    f.owner.profile(agentId); await f.owner.dispatch(agentId, async () => 'first');
    f.owner.profile(null); f.owner.profile(agentId);
    await expect(f.owner.dispatch(agentId, async () => 'reopened')).resolves.toBe('reopened');
    expect(f.changed.mock.calls.map(([id]) => id)).toEqual([agentId, null, agentId]);
  });
  it('real reconnect recovers the still-selected profile once, without a new focus or event read', async () => {
    const f = fixture(); f.owner.connected(1); f.owner.profile(agentId); const send = vi.fn(async () => 'cell');
    await f.owner.dispatch(agentId, send); f.owner.disconnected(); f.owner.connected(2);
    await f.owner.dispatch(agentId, send); f.owner.connected(2);
    await expect(f.owner.dispatch(agentId, send)).rejects.toThrow('not current'); expect(send).toHaveBeenCalledTimes(2);
  });
  it('close/navigation/background/identity/disconnect fence a late cell before it can paint', async () => {
    for (const boundary of ['close', 'navigation', 'background', 'identity', 'disconnect'] as const) {
      const f = fixture(); f.owner.connected(1); f.owner.profile(agentId);
      let resolve!: (value: string) => void; const pending = f.owner.dispatch(agentId, () => new Promise<string>(done => { resolve = done; }));
      if (boundary === 'close') f.owner.profile(null);
      if (boundary === 'navigation') f.navigate({ generation: 2, screen: 'AppShell' });
      if (boundary === 'background') { f.admission.background(); f.navigate(null); }
      if (boundary === 'identity') f.admission.reset({ origin: 'https://synthetic.test', principal: 'other', sessionEpoch: 2 });
      if (boundary === 'disconnect') f.owner.disconnected();
      resolve('late'); await expect(pending).rejects.toThrow('not current');
    }
  });
  it('healthy foreground is observation only and cannot replenish the previous read', async () => {
    const f = fixture(); f.owner.connected(1); f.owner.profile(agentId); await f.owner.dispatch(agentId, async () => 'first');
    f.admission.background(); f.navigate(null); f.admission.foregrounded(); f.navigate({ generation: 1, screen: 'AgentProfile', agentId });
    f.owner.profile(agentId); await expect(f.owner.dispatch(agentId, async () => 'extra')).rejects.toThrow('not current');
  });
});
