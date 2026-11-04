import type { ReadAuthority } from '@/buzz/read-authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneSocketDisconnectedError, PhoneSocketError } from './phone-socket-error';
const request = vi.hoisted(() => vi.fn());
const command = vi.hoisted(() => vi.fn());
vi.mock('@/buzz/command-owner', () => ({ activeCommandOwner: () => ({ execute: command }) }));
vi.mock('./live-connection', () => ({ sharedLiveConnection: () => ({ request }) }));
vi.mock('@/auth/monolith-session', () => ({
  MONOLITH_REQUEST_TIMEOUT_MS: 15_000,
  MonolithRequestTimeoutError: class extends Error {},
}));
vi.mock('@/auth/signin-funnel', () => ({ funnelSuccessfulOperation: vi.fn() }));
import { readServerSurface, monolithPhoneOperation, phoneOperationFailureReason, phoneOperationRequestOptions } from './monolith-operation';
import { MonolithRequestTimeoutError } from '@/auth/monolith-session';

beforeEach(() => { request.mockReset(); command.mockReset().mockImplementation((...args) => request(...args)); });
afterEach(() => { vi.useRealTimers(); });
describe('phone operations over the shared socket', () => {
  it('sends the operation and input once with the existing deadline', async () => {
    request.mockResolvedValueOnce({ messageId: 'm' });
    const input = { roomId: 'r', messageId: 'm', text: 'Hello' };
    await expect(monolithPhoneOperation('sendRoomMessage', input)).resolves.toEqual({ messageId: 'm' });
    expect(request).toHaveBeenCalledExactlyOnceWith('sendRoomMessage', input, { timeoutMs: 15_000 });
  });
  it('keeps the server refusal readable and never retries it', async () => {
    request.mockRejectedValueOnce(new PhoneSocketError('access_denied', 'Only an owner may approve this', false));
    const error = await monolithPhoneOperation('decideAgentGrant', { grantId: 'g', decision: 'always' }).catch(e => e);
    expect(phoneOperationFailureReason(error)).toBe('Only an owner may approve this');
    expect(request).toHaveBeenCalledOnce();
  });
  it('keeps empty operation results and explicit deadlines', async () => {
    request.mockResolvedValueOnce(undefined);
    await expect(monolithPhoneOperation('sendPushTest', {}, { timeoutMs: 40_000 })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith('sendPushTest', {}, { timeoutMs: 40_000 });
  });
  it('adds the local time zone when creating a Workspace', async () => {
    await monolithPhoneOperation('createWorkspace', { name: 'Example' });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ name: 'Example', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });
  it('preserves the special deadlines for external transactions', () => {
    expect(phoneOperationRequestOptions('actOnRepositoryCard', {})).toMatchObject({ timeoutMs: 60_000 });
    expect(phoneOperationRequestOptions('createGitHubRepository', {})).toMatchObject({ timeoutMs: 60_000 });
    expect(phoneOperationRequestOptions('approveCornerMerge', {})).toMatchObject({ timeoutMs: 540_000 });
    expect(phoneOperationRequestOptions('deleteWorkspace', {})).toMatchObject({ timeoutMs: 20_000 });
  });
  it.each([new PhoneSocketDisconnectedError(), new MonolithRequestTimeoutError()])('parks an ambiguous invite join until a separate explicit action', async failure => {
    vi.useFakeTimers();
    request.mockRejectedValueOnce(failure).mockResolvedValueOnce({ joined: false, workspaceId: 'w', roomId: 'r' });
    const error = await monolithPhoneOperation('redeemInvite', { token: 'invite' }).catch(error => error);
    expect(phoneOperationFailureReason(error)).toBe('Your join is not confirmed yet. Try Join again to check its result.');
    expect(request).toHaveBeenCalledExactlyOnceWith('redeemInvite', { token: 'invite' }, { timeoutMs: 40_000 });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(request).toHaveBeenCalledOnce();
    await expect(monolithPhoneOperation('redeemInvite', { token: 'invite' }))
      .resolves.toEqual({ joined: false, workspaceId: 'w', roomId: 'r' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('never replays an invite refused by the server', async () => {
    request.mockRejectedValueOnce(new PhoneSocketError('not_found', 'invite not found', false));
    await expect(monolithPhoneOperation('redeemInvite', { token: 'invite' })).rejects.toThrow('invite not found');
    expect(request).toHaveBeenCalledOnce();
  });
});

it('delegates writes to command admission while the raw connection receives only reads', async () => {
  command.mockResolvedValueOnce({ outcome: 'sent' });
  await expect(monolithPhoneOperation('sendFromWallet', {} as never)).resolves.toEqual({ outcome: 'sent' });
  expect(command).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ prompt: null });
  await expect(monolithPhoneOperation('readStarPrompt', {})).resolves.toEqual({ prompt: null });
  expect(request).toHaveBeenCalledExactlyOnceWith('readStarPrompt', {}, { timeoutMs: 15_000 });
});

it('keeps owned previews as reads and routes the legacy mark-seen form through command admission', async () => {
  const authority = {} as ReadAuthority;
  request.mockResolvedValueOnce({ items: [] });
  await readServerSurface(authority, 'readNeedsYou', { workspaceId: 'w', markSeen: false });
  expect(request).toHaveBeenCalledOnce(); expect(command).not.toHaveBeenCalled();
  command.mockResolvedValueOnce({ items: [] });
  await readServerSurface(authority, 'readNeedsYou', { workspaceId: 'w' });
  expect(command).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
});
