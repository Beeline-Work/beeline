import { captureServerError } from './sentry.js';

type ApprovalCardSource = { sourceRoomId?: string; sourceMessageId?: string };
type ApprovalSourceMessage = { id: string; room_id: string };

/** Check the stamped pair against the row already loaded by source resolution. */
export function approvalCardSource(
  cardKind: 'grant-request' | 'squire-approval',
  source: ApprovalCardSource,
  message: ApprovalSourceMessage | undefined,
): ApprovalCardSource {
  if (source.sourceMessageId && (!message || message.id !== source.sourceMessageId ||
      message.room_id !== source.sourceRoomId)) {
    captureServerError(new Error('Approval card source message is not in its source Room'), {
      cardKind,
      sourceMessageId: source.sourceMessageId,
      ...(source.sourceRoomId ? { sourceRoomId: source.sourceRoomId } : {}),
      ...(message ? { actualMessageId: message.id, actualRoomId: message.room_id } : {}),
    });
  }
  return source;
}
