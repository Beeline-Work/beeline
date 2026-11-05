import { describe, expect, it, vi } from 'vitest';
import { AdmissionOwner } from './admission.js';
import { MediaDemandOwner } from './media-demand-owner.js';
const room = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
function fixture(displays: () => readonly string[] = () => []) {
  const admission = new AdmissionOwner({ origin: 'https://example.test', principal: 'ada', sessionEpoch: 1 });
  let focus: { screen: string; generation: number; roomId?: string } | null = { screen: 'Room', generation: 1, roomId: room };
  const invalidate = vi.fn(); const owner = new MediaDemandOwner(admission, () => focus, invalidate, displays);
  return { admission, owner, invalidate, focus: (next: typeof focus) => { focus = next; owner.navigationChanged(); } };
}
describe('phone growth and recovery', () => {
  it.each([401, 403, 404, 410])('preserves a terminal server authority denial (%s) without retrying', async status => {
    vi.useFakeTimers();
    const f = fixture(); f.owner.connected(1); f.owner.viewport(room, [objectId]);
    const error = Object.assign(new Error('authority removed'), { status });
    const send = vi.fn().mockRejectedValue(error);
    try {
      await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(1);
    } finally { f.owner.disconnected(); vi.useRealTimers(); }
  });
  it.each([429, 503])('automatically recovers a failed metadata read and cancels backoff on disconnect (%s)', async status => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.owner.connected(1); f.owner.viewport(room, [objectId]);
      const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('temporary'), { status })).mockResolvedValue('current');
      const result = f.owner.dispatch('readMediaMetadata', objectId, send);
      await vi.advanceTimersByTimeAsync(499); expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('current');
      f.owner.action('OpenArtifact', objectId);
      const offline = vi.fn().mockRejectedValue(new Error('offline'));
      const pending = f.owner.dispatch('readMediaMetadata', objectId, offline).catch(error => error);
      await vi.advanceTimersByTimeAsync(1); f.owner.disconnected();
      expect(await pending).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(60_000); expect(offline).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('recovers all 1,895 current displays without viewport/recovery token ceilings and bounds active reads', async () => {
    const f = fixture(); f.owner.connected(1);
    const ids = Array.from({ length: 1895 }, (_, i) => String(i));
    f.owner.viewport(room, ids);
    for (const id of ids) f.owner.action('RunArtifact', id);
    f.owner.disconnected(); f.owner.connected(2);
    let active = 0, maximum = 0, reads = 0;
    const send = async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; reads++; return 'current'; };
    await Promise.all(ids.flatMap(id => [f.owner.dispatch('readMediaMetadata', id, send), f.owner.dispatch('readMediaPlayback', id, send)]));
    expect(reads).toBe(3790); expect(maximum).toBeLessThanOrEqual(8);
  });
  it('an evicted viewport object can be read again in the same navigation residency', async () => {
    const f = fixture(); f.owner.connected(1); const send = vi.fn(async (input: Readonly<{ objectId: string }>) => input);
    f.owner.viewport(room, [objectId]);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).resolves.toEqual({ objectId });
    f.owner.viewport(room, []); f.owner.viewport(room, [objectId]);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).resolves.toEqual({ objectId });
    f.focus({ screen: 'Room', roomId: room, generation: 2 }); f.owner.viewport(room, [objectId]);
    await f.owner.dispatch('readMediaMetadata', objectId, send); expect(send).toHaveBeenCalledTimes(3);
  });
});
