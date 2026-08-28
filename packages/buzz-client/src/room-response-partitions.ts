import type { RoomView, RoomViewMessage } from './room-view.js';

/** Persistable server responses only. Live, outbox, composer, and scroll state live elsewhere. */
export type RoomResponsePartitions = {
  readonly tail?: RoomView;
  readonly pages: readonly (readonly RoomViewMessage[])[];
};

export function replaceRoomTail(
  partitions: RoomResponsePartitions,
  tail: RoomView,
): RoomResponsePartitions {
  return { tail, pages: partitions.pages };
}

export function addRoomPage(
  partitions: RoomResponsePartitions,
  page: readonly RoomViewMessage[],
): RoomResponsePartitions {
  const tailIds = new Set(partitions.tail?.messages.map((message) => message.id) ?? []);
  const merged = new Map<string, RoomViewMessage>();
  for (const message of [...partitions.pages.flat(), ...page]) {
    if (!tailIds.has(message.id)) merged.set(message.id, message);
  }
  return {
    ...partitions,
    pages: [[...merged.values()].sort(tupleOrder)],
  };
}

/** Derived on render; never persisted as a unified transcript. */
export function composeRoomRows(
  partitions: RoomResponsePartitions,
  optimistic: readonly RoomViewMessage[] = [],
): readonly RoomViewMessage[] {
  const rows = new Map<string, RoomViewMessage>();
  for (const message of partitions.pages.flat()) rows.set(message.id, message);
  for (const message of partitions.tail?.messages ?? []) rows.set(message.id, message);
  for (const message of optimistic) {
    if (!rows.has(message.id)) rows.set(message.id, message);
  }
  return [...rows.values()].sort(tupleOrder);
}

function tupleOrder(left: RoomViewMessage, right: RoomViewMessage): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
