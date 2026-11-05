import type { AttachmentReference } from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import { canonical, type CommandIntent } from './command-owner';
import { getRandomBytes } from 'expo-crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { activeCommandOwner } from './command-owner';
import { preparedMessageOperation } from './prepared-message-operation';

/** Existing send handler calls this in its synchronous gesture prefix when all
 * final attachment references are already known. Persistence may finish after
 * the gesture; the prepared id/target/text/bytes never change afterwards. */
export function prepareRouterMessageGesture(input: { roomId: string; principal: string; text: string;
  attachments: readonly AttachmentReference[]; mentions: readonly string[]; parentMessageId?: string }):
  { event: NostrEvent; persisted: Promise<CommandIntent>; cancelBeforeSend: () => Promise<void> } | undefined {
  const owner = activeCommandOwner();
  if (!owner?.canPrepare()) return undefined;
  const event: NostrEvent = { id: bytesToHex(getRandomBytes(32)), pubkey: input.principal,
    created_at: Math.floor(Date.now() / 1000), kind: 9, sig: '', content: input.text,
    tags: [['h', input.roomId], ['monolith-attachments', JSON.stringify(input.attachments)],
      ['monolith-mentions', JSON.stringify(input.mentions)],
      ...(input.parentMessageId ? [['monolith-parent', input.parentMessageId]] : [])] };
  let persisted: Promise<CommandIntent>;
  try {
    if (owner.principal !== input.principal) throw new Error('Command principal changed');
    const { operation, input: args } = preparedMessageOperation(event);
    persisted = owner.prepare({ wire: { operation, input: canonical(args) },
      isCurrent: () => activeCommandOwner() === owner });
  } catch (error) { persisted = Promise.reject(error); }
  // The existing async send catch consumes the failure after its paint yield.
  void persisted.catch(() => undefined);
  return { event, persisted, cancelBeforeSend: () => persisted.then(record => owner.cancel(record.id)) };
}
