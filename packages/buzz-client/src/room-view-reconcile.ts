import type { RoomView, RoomViewMessage } from '@beeline/api-contract/phone';
import { ROOM_VIEW_MESSAGE_LIMIT, ROOM_VIEW_TOOL_ROW_LIMIT } from '@beeline/api-contract/phone';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Give a fresh authenticated Room response structural sharing with the last
 * response. Unchanged JSON subtrees keep their object identity, while every
 * changed field still comes from the new server-owned response.
 */
function shareResponseValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let unchanged = previous.length === next.length;
    const shared = next.map((value, index) => {
      const item = shareResponseValue(previous[index], value);
      if (item !== previous[index]) unchanged = false;
      return item;
    });
    return unchanged ? previous : shared;
  }
  if (isRecord(previous) && isRecord(next)) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    let unchanged = previousKeys.length === nextKeys.length;
    const shared: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const value = shareResponseValue(previous[key], next[key]);
      shared[key] = value;
      if (value !== previous[key]) unchanged = false;
    }
    return unchanged ? previous : shared;
  }
  return next;
}

function shareResponseArrayByKey<T>(
  previous: readonly T[],
  next: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const previousByKey = new Map(previous.map((value) => [key(value), value]));
  const shared = next.map((value) => shareResponseValue(previousByKey.get(key(value)), value) as T);
  return previous.length === shared.length &&
    shared.every((value, index) => value === previous[index])
    ? previous
    : shared;
}

function messageTimeMs(message: RoomViewMessage): number {
  return message.createdAtMs ?? message.createdAt * 1_000;
}

/** Keep a committed live delta that a slightly stale full snapshot has not
 * caught yet. The next window remains the authority for everything else. */
function mergeNewerCommittedMessages(
  previous: readonly RoomViewMessage[],
  next: readonly RoomViewMessage[],
): readonly RoomViewMessage[] {
  if (previous.length === 0) return next;
  const heldById = new Map(previous.map((message) => [message.id, message]));
  next = next.map((message) => {
    const held = heldById.get(message.id);
    return held && (held.version ?? 0) > (message.version ?? 0) ? held : message;
  });
  const nextIds = new Set(next.map((message) => message.id));
  const nextNewest = next.reduce((newest, message) => Math.max(newest, messageTimeMs(message)), 0);
  const extras = previous.filter(
    (message) => !nextIds.has(message.id) && messageTimeMs(message) >= nextNewest,
  );
  if (extras.length === 0) return next;
  return [...next, ...extras]
    .sort(
      (left, right) =>
        messageTimeMs(left) - messageTimeMs(right) || left.id.localeCompare(right.id),
    )
    .slice(-ROOM_VIEW_MESSAGE_LIMIT);
}

export function reconcileRoomView(previous: RoomView | null, next: RoomView): RoomView {
  if (!previous) return next;
  const messages = shareResponseArrayByKey(
    previous.messages,
    mergeNewerCommittedMessages(previous.messages, next.messages),
    (message) => message.id,
  );
  const members = shareResponseArrayByKey(
    previous.members,
    next.members,
    (member) => member.identity.pubkey,
  );
  const briefing = next.briefing
    ? shareResponseArrayByKey(previous.briefing ?? [], next.briefing, (message) => message.id)
    : undefined;
  return shareResponseValue(previous, {
    ...next,
    messages,
    members,
    ...(briefing ? { briefing } : {}),
  }) as RoomView;
}

function byMessageTime(left: RoomViewMessage, right: RoomViewMessage): number {
  return (
    (left.createdAtMs ?? left.createdAt * 1_000) - (right.createdAtMs ?? right.createdAt * 1_000) ||
    left.id.localeCompare(right.id)
  );
}

/** A settled corner tool or output row, which the full read returns in `toolRows`. */
function isCornerWorkRow(message: RoomViewMessage): boolean {
  return (
    message.presentation === 'activity' &&
    !message.durableFact &&
    Boolean(message.activity?.some((item) => item.kind === 'tool' || item.kind === 'output'))
  );
}

/** Merge one server-projected committed message into the bounded Room window.
 * A corner work row also joins `toolRows`, as the next full read returns it, so
 * the turn delta that prunes live activity cannot take it off screen. */
export function reconcileRoomMessageDelta(view: RoomView, message: RoomViewMessage): RoomView {
  const held = view.messages.find((candidate) => candidate.id === message.id);
  if (held && (held.version ?? 0) > (message.version ?? 0)) return view;
  const messages = [...view.messages.filter((candidate) => candidate.id !== message.id), message]
    .sort(byMessageTime)
    .slice(-ROOM_VIEW_MESSAGE_LIMIT);
  const toolRows =
    view.parent && isCornerWorkRow(message)
      ? [...(view.toolRows ?? []).filter((candidate) => candidate.id !== message.id), message]
          .sort(byMessageTime)
          .slice(-ROOM_VIEW_TOOL_ROW_LIMIT)
      : view.toolRows;
  return reconcileRoomView(view, { ...view, messages, ...(toolRows ? { toolRows } : {}) });
}

