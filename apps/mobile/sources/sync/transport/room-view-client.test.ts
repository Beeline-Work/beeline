import { beforeEach, describe, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('./live-connection', () => ({ sharedLiveConnection: () => ({ request }) }));
vi.mock('@/auth/monolith-session', () => ({ MONOLITH_REQUEST_TIMEOUT_MS: 15_000,
  MonolithRequestTimeoutError: class extends Error {} }));
import { MonolithRequestTimeoutError } from '@/auth/monolith-session';
import { RoomViewClient } from './room-view-client';
import { PhoneSocketError } from './phone-socket-error';
import { noteLiveFrame } from './live-frame-epoch';
const fixture = { workspaces: [], viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' }, truncated: false, watchFilters: [] };
const client = () => new RoomViewClient({ baseUrl: 'https://legacy.example', identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) } });
beforeEach(() => { request.mockReset(); });
describe('Room view socket reads', () => {
  it('validates the DTO returned on the socket', async () => {
    request.mockResolvedValueOnce(fixture);
    await expect(client().workspaces()).resolves.toEqual(fixture);
    expect(request).toHaveBeenCalledExactlyOnceWith('readWorkspaces', {}, { timeoutMs: 15_000, signal: undefined });
    request.mockResolvedValueOnce({ invalid: true });
    await expect(client().workspaces()).rejects.toMatchObject({ status: 502, code: 'invalid_surface_response' });
  });
  it('shares identical in-flight reads until a newer live frame arrives', async () => {
    let resolve!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(r => { resolve = r; }));
    const first = client().workspaces(), second = client().workspaces();
    expect(request).toHaveBeenCalledOnce();
    resolve(fixture); await Promise.all([first, second]);
    const third = client().workspaces(); const completeThird = resolve;
    noteLiveFrame(); const fourth = client().workspaces();
    expect(request).toHaveBeenCalledTimes(3);
    completeThird(fixture); resolve(fixture); await Promise.all([third, fourth]);
  });
  it('reports the existing read deadline and server refusal without retry', async () => {
    request.mockRejectedValueOnce(new MonolithRequestTimeoutError());
    await expect(client().room('r')).rejects.toMatchObject({ status: 0, code: 'timeout' });
    request.mockRejectedValueOnce(new PhoneSocketError('not_found', 'not_found', false));
    await expect(client().room('r')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('passes search cancellation through to its independent request', async () => {
    const controller = new AbortController();
    request.mockImplementation((_op, _args, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const read = client().searchMessages('w', 'gradle cache', 'cursor', controller.signal);
    expect(request).toHaveBeenCalledWith('searchMessages', { workspaceId: 'w', query: 'gradle cache', before: 'cursor' }, { timeoutMs: 15_000, signal: controller.signal });
    controller.abort(); await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('preserves history cursors, voice selection and archived corner arguments', async () => {
    request.mockRejectedValue(new Error('stop after transport'));
    const view = client(), before = { createdAt: 123, id: 'm' };
    await view.history('r', before).catch(() => {});
    await view.historyAfter('r', 'm').catch(() => {});
    await view.historyAround('r', 'm').catch(() => {});
    await view.agent('w', 'a', 'work-cursor').catch(() => {});
    await view.corners('r', { archived: true, before: 'corner-cursor' }).catch(() => {});
    await view.setAgentVoice('w', 'a', 'voice').catch(() => {});
    await view.markRead('r', 'm').catch(() => {});
    expect(request.mock.calls.map(([op, args]) => [op, args])).toEqual([
      ['readHistory', { roomId: 'r', before }], ['readHistoryAfter', { roomId: 'r', messageId: 'm' }],
      ['readHistoryAround', { roomId: 'r', messageId: 'm' }],
      ['readAgent', { workspaceId: 'w', agentId: 'a', workCursor: 'work-cursor' }],
      ['readCorners', { roomId: 'r', archived: true, before: 'corner-cursor' }],
      ['saveAgentVoice', { workspaceId: 'w', agentId: 'a', voiceId: 'voice' }],
      ['markRead', { roomId: 'r', messageId: 'm' }],
    ]);
  });
});
