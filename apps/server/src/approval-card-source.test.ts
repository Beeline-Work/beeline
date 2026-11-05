import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sentry from './sentry.js';
import { approvalCardSource } from './approval-card-source.js';

afterEach(() => vi.restoreAllMocks());

describe.each(['grant-request', 'squire-approval'] as const)('%s source stamping', kind => {
  it('captures one mismatch without changing or refusing the card source', () => {
    const capture = vi.spyOn(sentry, 'captureServerError').mockImplementation(() => undefined);
    const source = { sourceRoomId: 'wrong-room', sourceMessageId: 'request' };
    expect(approvalCardSource(kind, source, { id: 'request', room_id: 'actual-room' })).toBe(source);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      cardKind: kind, sourceRoomId: 'wrong-room', sourceMessageId: 'request',
      actualRoomId: 'actual-room', actualMessageId: 'request',
    });
  });

  it('keeps matching pairs and absent source links quiet', () => {
    const capture = vi.spyOn(sentry, 'captureServerError').mockImplementation(() => undefined);
    approvalCardSource(kind, { sourceRoomId: 'room', sourceMessageId: 'request' }, { id: 'request', room_id: 'room' });
    approvalCardSource(kind, {}, undefined);
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures a stamped message that no longer resolves', () => {
    const capture = vi.spyOn(sentry, 'captureServerError').mockImplementation(() => undefined);
    approvalCardSource(kind, { sourceRoomId: 'room', sourceMessageId: 'request' }, undefined);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
