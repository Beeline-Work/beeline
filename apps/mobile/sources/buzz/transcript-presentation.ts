import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

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

function transcriptMessageMatches(message: ChatDisplayMessage, messageId: string): boolean {
  return message.id === messageId || message.relayId === messageId;
}

export type TranscriptAnchorRestore = 'scrolled' | 'revealed' | 'missing';

/** Restore an anchor from the visible slice, widening through resident rows first when needed. */
export function restoreTranscriptAnchor({
  messageId,
  transcriptMessages,
  residentMessages,
  onReveal,
  onScroll,
}: {
  messageId: string;
  transcriptMessages: readonly ChatDisplayMessage[];
  residentMessages: readonly ChatDisplayMessage[];
  onReveal(rowsFromNewest: number): void;
  onScroll(index: number, viewPosition: number): void;
}): TranscriptAnchorRestore {
  const visibleIndex = transcriptMessages.findIndex((message) =>
    transcriptMessageMatches(message, messageId),
  );
  if (visibleIndex >= 0) {
    onScroll(visibleIndex, 0.5);
    return 'scrolled';
  }
  const residentIndex = residentMessages.findIndex((message) =>
    transcriptMessageMatches(message, messageId),
  );
  if (residentIndex < 0) return 'missing';
  onReveal(residentMessages.length - residentIndex);
  return 'revealed';
}
