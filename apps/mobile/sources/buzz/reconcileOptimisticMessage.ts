type IdentifiedMessage = {
  id: string;
};

/** Reconcile a local optimistic message with its published relay event id. */
export function reconcileOptimisticMessage<T extends IdentifiedMessage>(
  messages: T[],
  optimisticId: string,
  eventId: string,
): T[] {
  if (messages.some((message) => message.id === eventId)) {
    return messages.filter((message) => message.id !== optimisticId);
  }

  return messages.map((message) =>
    message.id === optimisticId ? { ...message, id: eventId } : message,
  );
}
