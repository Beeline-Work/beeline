import type { NostrEvent } from '@beeline/nostr';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';

/** Same immutable prepared event selects exactly one wire operation on both
 * legacy and durable delivery paths. No route/pass/held-state metadata leaves. */
export function preparedMessageOperation(event: NostrEvent): {
  operation: 'sendRoomMessage' | 'sendRoomReply';
  input: PhoneOperationMap['sendRoomMessage']['input'] & { parentMessageId?: string };
} {
  const tag = (name: string) => event.tags.find(item => item[0] === name)?.[1];
  const roomId = tag('h');
  if (!roomId) throw new Error('Prepared monolith message has no Room');
  const parentMessageId = tag('monolith-parent');
  return { operation: parentMessageId ? 'sendRoomReply' : 'sendRoomMessage', input: {
    roomId, messageId: event.id, text: event.content,
    mentions: JSON.parse(tag('monolith-mentions') ?? '[]'),
    attachments: JSON.parse(tag('monolith-attachments') ?? '[]'),
    ...(parentMessageId ? { parentMessageId } : {}),
  } };
}
