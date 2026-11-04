import { describe, expect, it, vi } from 'vitest';
import { AdmissionOwner } from './private/admission.js';
import { MediaDemandOwner } from './private/media-demand-owner.js';
const room = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
function fixture(displays: () => readonly string[] = () => []) {
  const admission = new AdmissionOwner({ origin: 'https://example.test', principal: 'ada', sessionEpoch: 1 });
  let focus: { screen: string; generation: number; roomId?: string } | null = { screen: 'Room', generation: 1, roomId: room };
  const invalidate = vi.fn(); const owner = new MediaDemandOwner(admission, () => focus, invalidate, displays);
  return { admission, owner, invalidate, focus: (next: typeof focus) => { focus = next; owner.navigationChanged(); } };
}
describe('real private media demand ownership', () => {
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
  it('unsupported servers and overscan cannot grant metadata work', async () => {
    const f = fixture(); const send = vi.fn(async () => 'bytes');
    f.owner.viewport(room, [objectId]); f.owner.action('OpenArtifact', objectId);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
    f.owner.viewport(room, []); f.owner.connected(1);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
    expect(send).not.toHaveBeenCalled();
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
  it('leaving visibility fences a metadata reply without an automatic replacement request', async () => {
    const f = fixture(); f.owner.connected(1); f.owner.viewport(room, [objectId]);
    let resolve!: (value: string) => void; const send = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const pending = f.owner.dispatch('readMediaMetadata', objectId, send); f.owner.viewport(room, []); resolve('late');
    await expect(pending).rejects.toThrow('not current'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('Open/copy/save spend synchronously and cannot issue a different object or operation', async () => {
    const f = fixture(); f.owner.connected(1); const send = vi.fn(async () => 'link');
    for (const action of ['OpenArtifact', 'CopyArtifact', 'SaveArtifact'] as const) {
      f.owner.action(action, objectId); await Promise.resolve();
      await expect(f.owner.dispatch('readMediaLink', objectId, send)).rejects.toThrow('not current');
      await expect(f.owner.dispatch('readMediaMetadata', `${objectId.slice(0, -1)}3`, send)).rejects.toThrow('not current');
      await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).resolves.toBe('link');
    }
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('browser and runnable actions admit only their closed existing operation', async () => {
    const f = fixture(); f.owner.connected(1); const send = vi.fn(async () => 'url');
    f.owner.action('OpenArtifactBrowser', objectId); await f.owner.dispatch('readMediaLink', objectId, send);
    f.owner.action('RunArtifact', objectId); await f.owner.dispatch('readMediaMetadata', objectId, send); await f.owner.dispatch('readMediaPlayback', objectId, send);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('joining a held value or existing flight consumes the saved wire opportunity', async () => {
    const f = fixture(); f.owner.connected(1); const send = vi.fn(async () => 'must not send');
    f.owner.viewport(room, [objectId]); f.owner.satisfy('readMediaMetadata', objectId);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
    f.owner.action('OpenArtifact', objectId); f.owner.satisfy('readMediaMetadata', objectId);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
    expect(send).not.toHaveBeenCalled();
    f.owner.action('OpenArtifact', objectId); await f.owner.dispatch('readMediaMetadata', objectId, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('navigation, identity, background and disconnect fence action completion', async () => {
    for (const boundary of ['navigation', 'identity', 'background', 'disconnect'] as const) {
      const f = fixture(); f.owner.connected(1); f.owner.action('SaveArtifact', objectId);
      let resolve!: (value: string) => void;
      const pending = f.owner.dispatch('readMediaMetadata', objectId, () => new Promise<string>(done => { resolve = done; }));
      if (boundary === 'navigation') f.focus({ screen: 'AppShell', generation: 2 });
      if (boundary === 'identity') f.admission.reset({ origin: 'https://example.test', principal: 'grace', sessionEpoch: 2 });
      if (boundary === 'background') f.admission.background();
      if (boundary === 'disconnect') f.owner.disconnected();
      resolve('late'); await expect(pending).rejects.toThrow('not current');
    }
  });
  it('a real connection epoch replays actual retained viewport demand once without a new callback or focus', async () => {
    const f = fixture(); f.owner.connected(1); f.owner.viewport(room, [objectId]);
    const send = vi.fn(async () => 'value'); await f.owner.dispatch('readMediaMetadata', objectId, send);
    f.owner.disconnected(); f.owner.connected(2);
    await f.owner.dispatch('readMediaMetadata', objectId, send);
    f.owner.connected(2); f.owner.viewport(room, [objectId]);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('recovers a currently displayed off-viewport Open object but never a hidden historical action or changed navigation', async () => {
    const active: string[] = []; const f = fixture(() => active); f.owner.connected(1);
    f.owner.action('OpenArtifact', objectId); await f.owner.dispatch('readMediaMetadata', objectId, async () => 'first');
    active.push(objectId); f.owner.disconnected(); f.owner.connected(2);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, async () => 'recovered')).resolves.toBe('recovered');
    active.length = 0; f.owner.disconnected(); f.owner.connected(3);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, async () => 'hidden')).rejects.toThrow('not current');
    active.push(objectId); f.focus({ screen: 'Room', roomId: room, generation: 2 }); f.owner.disconnected(); f.owner.connected(4);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, async () => 'old-navigation')).rejects.toThrow('not current');
  });
  it('foreground resumes local observation without reminting already seen viewport work', async () => {
    const f = fixture(); f.owner.connected(1); f.owner.viewport(room, [objectId]);
    await f.owner.dispatch('readMediaMetadata', objectId, async () => 'first');
    f.admission.background(); f.admission.foregrounded(); f.owner.navigationChanged(); f.owner.viewport(room, [objectId]);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, async () => 'again')).rejects.toThrow('not current');
    f.owner.action('OpenArtifact', objectId);
    await expect(f.owner.dispatch('readMediaMetadata', objectId, async () => 'explicit')).resolves.toBe('explicit');
  });
});


it('F23: a browser gesture owns metadata and link, and a cache join consumes its metadata opportunity', async () => {
  const f = fixture(); f.owner.connected(1); const send = vi.fn(async () => 'capability');
  f.owner.action('OpenArtifactBrowser', objectId);
  await f.owner.dispatch('readMediaMetadata', objectId, send);
  await f.owner.dispatch('readMediaLink', objectId, send);
  await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
  f.owner.action('OpenArtifactBrowser', objectId); f.owner.satisfy('readMediaMetadata', objectId);
  await expect(f.owner.dispatch('readMediaMetadata', objectId, send)).rejects.toThrow('not current');
  await f.owner.dispatch('readMediaLink', objectId, send);
  expect(send).toHaveBeenCalledTimes(3);
});
