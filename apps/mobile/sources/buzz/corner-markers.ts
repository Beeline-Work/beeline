/**
 * A corner a person opened FROM a message (the swipe-right forward) is one
 * durable `corner-open` card naming that message (`daemonFact.sourceMessageId`).
 * Its place in the transcript is beneath that message, not where it happened
 * to land in time: this moves each such card off its own row and onto the
 * source message's `cornerMarkers`, in the order the corners were opened.
 *
 * A card whose source is not resident (older history not paged in, a deleted
 * row) stays hidden until its source is resident. Corners remain in the list.
 */
type MarkerCarrier = {
  id: string;
  relayId?: string;
  systemEvent?: { kind?: string };
  daemonFact?: { sourceMessageId?: string; type?: string };
};

export function isCornerOpen(message: MarkerCarrier): boolean {
  return message.daemonFact?.type === 'corner-open' ||
    message.systemEvent?.kind === 'corner-opened';
}

export function anchorCornerMarkers<T extends MarkerCarrier>(
  messages: readonly T[],
): (T & { cornerMarkers?: T[] })[] {
  const resident = new Map<string, string>();
  for (const message of messages) {
    // A marker never carries another marker: it leaves its own row.
    if (isCornerOpen(message) || message.daemonFact?.sourceMessageId) continue;
    resident.set(message.id, message.id);
    if (message.relayId) resident.set(message.relayId, message.id);
  }
  const markers = new Map<string, T[]>();
  for (const message of messages) {
    if (!isCornerOpen(message)) continue;
    const source = message.daemonFact?.sourceMessageId;
    const anchor = source ? resident.get(source) : undefined;
    if (!anchor) continue;
    markers.set(anchor, [...(markers.get(anchor) ?? []), message]);
  }
  return messages.flatMap((message) => {
    if (isCornerOpen(message)) return [];
    const attached = markers.get(message.id);
    return [attached ? { ...message, cornerMarkers: attached } : message];
  });
}
