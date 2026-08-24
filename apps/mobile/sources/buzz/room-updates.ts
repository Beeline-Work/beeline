import type { NostrEvent } from '@beeline/nostr';
import {
  KIND_CORNER_STATE,
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  TAG_CORNER_STATE,
  TAG_PARENT,
  tagValue,
} from '@beeline/buzz-client';

export const ROOM_UPDATE_FLAP_SECONDS = 60;
export const ROOM_UPDATE_DIGEST_MAX_CHARS = 140;
const ROOM_REPOSITORY_MARKER = 'buzz-room-repository';

export type RoomUpdate = {
  id: string;
  timestamp: number;
  kind:
    | 'member-joined'
    | 'member-left'
    | 'agent-seated'
    | 'agent-removed'
    | 'corner-opened'
    | 'corner-reported'
    | 'corner-merged'
    | 'corner-closed'
    | 'invite-only'
    | 'renamed'
    | 'repository-linked'
    | 'picture-set';
  memberPubkey?: string;
  actorPubkey?: string;
  cornerId?: string;
  objective?: string;
  branch?: string;
  tip?: string;
  digest?: string;
  name?: string;
};

type MembershipUpdate = RoomUpdate & {
  memberPubkey: string;
  kind: 'member-joined' | 'member-left' | 'agent-seated' | 'agent-removed';
};

function chronological(events: readonly NostrEvent[]): NostrEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
}

function words(text: string | undefined, maximum: number): string | undefined {
  const normalized = text
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/\.{2,}$/, '.');
  if (!normalized) return undefined;
  const parts = normalized.split(' ');
  if (parts.length <= maximum) return normalized;
  return `${parts.slice(0, maximum).join(' ')}…`;
}

function tagFrom(event: NostrEvent | undefined, name: string): string | undefined {
  return event ? tagValue(event, name) : undefined;
}

function cappedDigest(text: string | undefined): string | undefined {
  const normalized = text
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/\.{2,}$/, '.');
  if (!normalized) return undefined;
  if (normalized.length <= ROOM_UPDATE_DIGEST_MAX_CHARS) return normalized;
  return `${normalized.slice(0, ROOM_UPDATE_DIGEST_MAX_CHARS - 1).trimEnd()}…`;
}

function mergeDigest(event: NostrEvent): string | undefined {
  const marker = event.tags.find((tag) => tag[0] === 't')?.[1];
  if (marker === 'merge-summary') {
    const body =
      event.content
        .split(/\n\s*\n/)
        .slice(1)
        .join(' ')
        .trim() || event.content;
    return cappedDigest(body.replace(/^🤖\s*Merge summary\s*—[^\n]*/i, ''));
  }
  if (marker === 'land-summary') {
    const landed = event.content.match(/(?:^|\n)Landed:\s*([^\n]+)/i)?.[1];
    return cappedDigest(landed ?? event.content);
  }
  return undefined;
}

function coalesceMembershipFlaps(updates: MembershipUpdate[]): MembershipUpdate[] {
  const removed = new Set<number>();
  const pending = new Map<string, number>();
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index]!;
    const priorIndex = pending.get(update.memberPubkey);
    const prior = priorIndex === undefined ? undefined : updates[priorIndex];
    const priorJoined = prior?.kind === 'member-joined' || prior?.kind === 'agent-seated';
    const joined = update.kind === 'member-joined' || update.kind === 'agent-seated';
    if (
      prior &&
      priorJoined !== joined &&
      update.timestamp - prior.timestamp <= ROOM_UPDATE_FLAP_SECONDS
    ) {
      removed.add(priorIndex!);
      removed.add(index);
      pending.delete(update.memberPubkey);
      continue;
    }
    pending.set(update.memberPubkey, index);
  }
  return updates.filter((_, index) => !removed.has(index));
}

/**
 * Statelessly derive quiet transcript notices from relay structure. A
 * kind:9 control card can enrich a canonical merge with its already-written
 * digest, but it can never create an open/merge/close update by itself.
 */
export function deriveRoomUpdates(
  roomId: string,
  inputEvents: readonly NostrEvent[],
  agentPubkeys: ReadonlySet<string>,
): RoomUpdate[] {
  const events = chronological(inputEvents);
  const memberships: MembershipUpdate[] = [];
  const membershipState = new Map<string, boolean>();

  for (const event of events) {
    if (
      (event.kind !== KIND_PUT_USER && event.kind !== KIND_REMOVE_USER) ||
      tagValue(event, 'h') !== roomId
    )
      continue;
    const memberPubkey = tagValue(event, 'p');
    if (!memberPubkey) continue;
    const joined = event.kind === KIND_PUT_USER;
    if (membershipState.get(memberPubkey) === joined) continue;
    membershipState.set(memberPubkey, joined);
    const agent = agentPubkeys.has(memberPubkey);
    memberships.push({
      id: `room-update:${event.id}`,
      timestamp: event.created_at,
      memberPubkey,
      ...(joined && agent
        ? { kind: 'agent-seated' as const, actorPubkey: event.pubkey }
        : joined
          ? { kind: 'member-joined' as const }
          : agent
            ? { kind: 'agent-removed' as const }
            : { kind: 'member-left' as const }),
    });
  }

  const updates: RoomUpdate[] = [...coalesceMembershipFlaps(memberships)];
  const roomCreate = events.find(
    (event) => event.kind === KIND_CREATE_GROUP && tagValue(event, 'h') === roomId,
  );
  let knownName = tagFrom(roomCreate, 'name');
  let knownVisibility = tagFrom(roomCreate, 'visibility');
  let knownPicture = roomCreate
    ? (tagValue(roomCreate, 'avatar') ?? tagValue(roomCreate, 'picture'))
    : undefined;

  for (const event of events) {
    if (event.kind !== KIND_EDIT_METADATA || tagValue(event, 'h') !== roomId) continue;
    const name = tagValue(event, 'name')?.trim();
    if (name && name !== knownName) {
      updates.push({
        id: `room-update:${event.id}:renamed`,
        kind: 'renamed',
        timestamp: event.created_at,
        name,
      });
      knownName = name;
    }
    const visibility =
      tagValue(event, 'visibility') ??
      (event.tags.some((tag) => tag[0] === 'private') ? 'private' : undefined);
    if (visibility && visibility !== knownVisibility) {
      if (visibility === 'private' || visibility === 'invite-only') {
        updates.push({
          id: `room-update:${event.id}:invite-only`,
          kind: 'invite-only',
          timestamp: event.created_at,
        });
      }
      knownVisibility = visibility;
    }
    const picture = tagValue(event, 'avatar') ?? tagValue(event, 'picture');
    if (picture && picture !== knownPicture) {
      updates.push({
        id: `room-update:${event.id}:picture`,
        kind: 'picture-set',
        timestamp: event.created_at,
      });
      knownPicture = picture;
    }
  }

  let repositoryKey = roomCreate ? tagValue(roomCreate, 'repo-key') : undefined;
  if (repositoryKey && roomCreate) {
    updates.push({
      id: `room-update:${roomCreate.id}:repository`,
      kind: 'repository-linked',
      timestamp: roomCreate.created_at,
    });
  }
  for (const event of events) {
    if (
      event.kind !== KIND_CORNER_STATE ||
      tagValue(event, 'h') !== roomId ||
      tagValue(event, 't') !== ROOM_REPOSITORY_MARKER
    )
      continue;
    let nextKey: string | undefined;
    try {
      const content = JSON.parse(event.content) as { key?: unknown };
      nextKey = typeof content.key === 'string' ? content.key.trim() : undefined;
    } catch {
      // Malformed repository state is not a fact.
    }
    if (!nextKey || nextKey === repositoryKey) continue;
    repositoryKey = nextKey;
    updates.push({
      id: `room-update:${event.id}:repository`,
      kind: 'repository-linked',
      timestamp: event.created_at,
    });
  }

  const cornerCreates = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== KIND_CREATE_GROUP || tagValue(event, TAG_PARENT) !== roomId) continue;
    const cornerId = tagValue(event, 'h');
    if (cornerId && !cornerCreates.has(cornerId)) cornerCreates.set(cornerId, event);
  }
  const stateByCorner = new Map<string, NostrEvent[]>();
  for (const event of events) {
    if (
      event.kind !== KIND_CORNER_STATE ||
      tagValue(event, 'h') !== roomId ||
      tagValue(event, 't') !== TAG_CORNER_STATE
    )
      continue;
    const d = tagValue(event, 'd');
    const prefix = `${TAG_CORNER_STATE}:`;
    if (!d?.startsWith(prefix)) continue;
    const cornerId = d.slice(prefix.length);
    if (!cornerId) continue;
    const list = stateByCorner.get(cornerId) ?? [];
    list.push(event);
    stateByCorner.set(cornerId, list);
  }

  for (const [cornerId, rawStateEvents] of stateByCorner) {
    const create = cornerCreates.get(cornerId);
    if (!create) continue;
    // The immutable child creator is the lifecycle author. Another signer can
    // publish the same parameterized `d`, but cannot speak for this corner.
    const stateEvents = chronological(rawStateEvents).filter(
      (event) => event.pubkey === create.pubkey,
    );
    const states = stateEvents.map((event) => ({
      event,
      state: tagValue(event, 'state') === 'waiting-on-human' ? 'waiting' : tagValue(event, 'state'),
      reason: tagValue(event, 'reason'),
    }));
    const latest = states.at(-1);
    if (!latest?.state) continue;

    const explicitOpen = states.find(({ state }) => state === 'open')?.event;
    // A parameterized-replaceable lifecycle may backfill only its newest
    // value. The canonical state proves that this corner actor exists; its
    // immutable kind:9007 create supplies the historical opening timestamp.
    const openedAt = explicitOpen ?? create;
    updates.push({
      id: `room-update:${openedAt.id}:opened`,
      kind: 'corner-opened',
      timestamp: openedAt.created_at,
      cornerId,
      objective: tagFrom(create, 'task') ?? tagFrom(create, 'objective') ?? tagFrom(create, 'name'),
    });

    const landEvents = events
      .filter(
        (candidate) =>
          tagValue(candidate, 'subchannel') === cornerId &&
          (tagValue(candidate, 'delivery') === 'landed' ||
            ['landed', 'land-summary', 'merge-summary'].includes(tagValue(candidate, 't') ?? '')),
      )
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    const concluded = states.find(({ state }) => state === 'concluded')?.event;
    // CLOSED can be the only replaceable value returned to a historical
    // client. It implies a merge only when an existing land record proves one;
    // an abandoned/removed corner still renders only opened + closed.
    const tagged = landEvents.find((candidate) => tagValue(candidate, 'tip'));
    const digestEvent =
      landEvents.find((candidate) => tagValue(candidate, 't') === 'merge-summary') ??
      landEvents.find((candidate) => mergeDigest(candidate));
    const reported =
      states.find(
        ({ state, reason }) => state === 'idle' || (state === 'waiting' && reason === 'review'),
      )?.event ??
      ((latest.state === 'concluded' || latest.state === 'closed') && digestEvent
        ? digestEvent
        : undefined);
    if (reported) {
      updates.push({
        id: `room-update:${reported.id}:reported`,
        kind: 'corner-reported',
        timestamp: reported.created_at,
        cornerId,
      });
    }
    // The approved merge surface is indivisible: no short SHA or existing
    // summary means no partial “merged” notice. A later backfill/live record
    // will make the complete update appear without generating copy.
    if (
      (concluded || (latest.state === 'closed' && landEvents.length > 0)) &&
      tagFrom(tagged, 'tip') &&
      digestEvent
    ) {
      const mergedAt = concluded ?? tagged ?? latest.event;
      updates.push({
        id: `room-update:${mergedAt.id}:merged`,
        kind: 'corner-merged',
        timestamp: mergedAt.created_at,
        cornerId,
        branch: tagValue(tagged ?? mergedAt, 'branch')?.replace(/^refs\/heads\//, '') ?? 'main',
        tip: tagValue(tagged ?? mergedAt, 'tip'),
        digest: mergeDigest(digestEvent),
      });
    }

    if (latest.state === 'closed') {
      updates.push({
        id: `room-update:${latest.event.id}:closed`,
        kind: 'corner-closed',
        timestamp: latest.event.created_at,
        cornerId,
      });
    }
  }

  const lifecycleOrder: Partial<Record<RoomUpdate['kind'], number>> = {
    'corner-opened': 0,
    'corner-reported': 1,
    'corner-merged': 2,
    'corner-closed': 3,
  };
  return updates.sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      (lifecycleOrder[a.kind] ?? 0) - (lifecycleOrder[b.kind] ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

export function roomUpdateLine(
  update: RoomUpdate,
  identityName: (pubkey: string) => string,
): string {
  const member = update.memberPubkey
    ? (words(identityName(update.memberPubkey), 1) ?? 'Member')
    : '';
  const actor = update.actorPubkey ? (words(identityName(update.actorPubkey), 1) ?? 'someone') : '';
  switch (update.kind) {
    case 'member-joined':
      return `○ ${member} joined`;
    case 'member-left':
      return `○ ${member} left`;
    case 'agent-seated':
      return `△ ${member} seated by ${actor}`;
    case 'agent-removed':
      return `△ ${member} removed`;
    case 'corner-opened':
      return `⌗ corner opened${update.objective ? ` — ${words(update.objective, 3)}` : ''}`;
    case 'corner-reported':
      return '⌗ corner reported back';
    case 'corner-merged':
      return `⌗ merged → main @ ${(update.tip ?? 'unknown').slice(0, 8)}`;
    case 'corner-closed':
      return '⌗ corner closed';
    case 'invite-only':
      return '▢ set to invite-only';
    case 'renamed':
      return `▢ renamed to ${words(update.name, 3) ?? 'Room'}`;
    case 'repository-linked':
      return '▢ repository linked';
    case 'picture-set':
      return '▢ picture set';
  }
}
