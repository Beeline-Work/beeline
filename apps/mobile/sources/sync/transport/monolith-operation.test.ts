import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneSocketError } from './phone-socket-error';
const request = vi.hoisted(() => vi.fn());
vi.mock('./live-connection', () => ({ sharedLiveConnection: () => ({ request }) }));
vi.mock('@/auth/monolith-session', () => ({ MONOLITH_REQUEST_TIMEOUT_MS: 15_000 }));
vi.mock('@/auth/signin-funnel', () => ({ funnelSuccessfulOperation: vi.fn() }));
import { monolithPhoneOperation, phoneOperationFailureReason, phoneOperationRequestOptions } from './monolith-operation';

beforeEach(() => { request.mockReset(); });
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
});
