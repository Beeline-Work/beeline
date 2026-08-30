import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

/**
 * Whether a projected transcript record owns a visible FlatList row.
 *
 * Some legacy control receipts remain in the normalized transcript so their
 * state can drive the header or a parent Room, but deliberately have no
 * presentation in this ledger. Filter them before pagination and before they
 * reach FlatList: returning `null` from renderItem can leave a recycled row's
 * measurement behind and, more importantly, lets invisible records consume a
 * bounded history window.
 */
export function rendersTranscriptRow(message: ChatDisplayMessage): boolean {
  if (message.corner) return false;
  return !(
    message.writePermission?.status === 'allowed' &&
    message.writePermission.subchannelId !== undefined
  );
}

/**
 * Apply the ledger's no-row policy before selecting a bounded tail. This keeps
 * the first corner page full of actual prose rather than machine receipts.
 */
export function visibleTranscriptWindow(
  messages: readonly ChatDisplayMessage[],
  limit: number,
): ChatDisplayMessage[] {
  return messages.filter(rendersTranscriptRow).slice(-Math.max(0, limit));
}
