/**
 * A corner a person opened FROM a message (the swipe-right forward) is one
 * durable `corner-open` card naming that message (`daemonFact.sourceMessageId`).
 * Its place in the transcript is beneath that message, not where it happened
 * to land in time: this moves each such card off its own row and onto the
 * source message's `cornerMarkers`, in the order the corners were opened.
 *
 * A card whose source is not resident (older history not paged in, a deleted
 * row) stays on its own row, so the corner it opened is never unreachable.
 */
type MarkerCarrier = {
  id: string;
  relayId?: string;
  daemonFact?: { sourceMessageId?: string };
};

export function anchorCornerMarkers<T extends MarkerCarrier>(
  messages: readonly T[],
): (T & { cornerMarkers?: T[] })[] {
  const resident = new Map<string, string>();
  for (const message of messages) {
    // A marker never carries another marker: it leaves its own row.
    if (message.daemonFact?.sourceMessageId) continue;
    resident.set(message.id, message.id);
    if (message.relayId) resident.set(message.relayId, message.id);
  }
  const markers = new Map<string, T[]>();
  const anchored = new Set<string>();
  for (const message of messages) {
    const source = message.daemonFact?.sourceMessageId;
    const anchor = source ? resident.get(source) : undefined;
    if (!anchor) continue;
    markers.set(anchor, [...(markers.get(anchor) ?? []), message]);
    anchored.add(message.id);
  }
  if (!anchored.size) return [...messages];
  return messages.flatMap((message) => {
    if (anchored.has(message.id)) return [];
    const attached = markers.get(message.id);
    return [attached ? { ...message, cornerMarkers: attached } : message];
  });
}
