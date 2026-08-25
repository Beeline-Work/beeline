export type MentionableAgent = { pubkey: string; name: string; handle?: string };
type RoomRosterMember = { pubkey: string };
type RoomParticipant = RoomRosterMember & { kind: 'person' | 'agent' };

export type MentionCandidate = {
  name: string;
  handle: string;
};

export type MentionableParticipant = MentionCandidate & {
  pubkey: string;
};

export type ResolvedComposerMentions = {
  pubkeys: string[];
  handles: string[];
};

export type ActiveMention = {
  start: number;
  end: number;
  query: string;
};

const MENTION_QUERY_PATTERN = /(?:^|[\s([{])@([\p{L}\p{M}\p{N}_-]*)$/u;

function normalizeMentionSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

/** Find the mention fragment ending at a collapsed composer cursor. */
export function activeMentionAtCursor(text: string, cursor: number): ActiveMention | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  const beforeCursor = text.slice(0, cursor);
  const match = MENTION_QUERY_PATTERN.exec(beforeCursor);
  if (!match) return null;
  const query = match[1] ?? '';
  return {
    start: cursor - query.length - 1,
    end: cursor,
    query,
  };
}

/** Prefix matches lead substring matches while preserving Room roster order within each group. */
export function filterMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit = 6,
): { matches: T[]; overflow: number } {
  const normalizedQuery = normalizeMentionSearch(query);
  const matching = candidates
    .map((candidate, index) => {
      const name = normalizeMentionSearch(candidate.name);
      const handle = normalizeMentionSearch(candidate.handle);
      if (!name.includes(normalizedQuery) && !handle.includes(normalizedQuery)) return null;
      return {
        candidate,
        index,
        prefix: name.startsWith(normalizedQuery) || handle.startsWith(normalizedQuery),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || a.index - b.index);
  const safeLimit = Math.max(0, limit);
  return {
    matches: matching.slice(0, safeLimit).map((item) => item.candidate),
    overflow: Math.max(0, matching.length - safeLimit),
  };
}

/** Replace only the active @fragment and return the cursor position after the inserted handle. */
export function replaceActiveMention(
  text: string,
  mention: ActiveMention,
  handle: string,
): { text: string; cursor: number } {
  const inserted = `@${handle}`;
  return {
    text: `${text.slice(0, mention.start)}${inserted}${text.slice(mention.end)}`,
    cursor: mention.start + inserted.length,
  };
}

/** Keep one Workspace roster, ordered as current Room members followed by addable members. */
export function sectionRoomRoster<T extends RoomRosterMember>(
  roster: T[],
  roomMemberPubkeys: ReadonlySet<string>,
): { inRoom: T[]; addable: T[] } {
  const inRoom: T[] = [];
  const addable: T[] = [];
  for (const member of roster) {
    (roomMemberPubkeys.has(member.pubkey) ? inRoom : addable).push(member);
  }
  return { inRoom, addable };
}

/** Split the authoritative Room roster by visible identity kind. */
export function sectionRoomParticipants<T extends RoomParticipant>(
  participants: T[],
): {
  people: T[];
  agents: T[];
} {
  return {
    people: participants.filter((participant) => participant.kind === 'person'),
    agents: participants.filter((participant) => participant.kind === 'agent'),
  };
}

/** Slack-style participant copy: five names at most, with overflow folded into the fifth slot. */
export function formatRoomParticipantList(names: string[]): string {
  if (names.length <= 5) return names.join(', ');
  return `${names.slice(0, 4).join(', ')} and ${names.length - 4} others`;
}

/** Compact header member count; the unified roster sheet carries the actual names. */
export function formatRoomParticipantTotal(total: number): string {
  return `${total} ${total === 1 ? 'member' : 'members'}`;
}

/**
 * Resolve an agent the user picked from the mention dropdown, but only while
 * its handle is still literally present in the text being sent — the picker's
 * selections outlive the message they were made in.
 */
export function selectedMentionAgentPubkey(
  text: string,
  selections: ReadonlyMap<string, string>,
): string | undefined {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  return [...selections.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .find(([handle]) => {
      const mention = `@${handle.normalize('NFKC').toLocaleLowerCase()}`;
      const offset = normalized.indexOf(mention);
      if (offset < 0) return false;
      const trailing = normalized[offset + mention.length];
      return trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing);
    })?.[1];
}

/** Resolve every picker-selected mention whose handle is still present in the sent text. */
export function selectedMentionPubkeys(
  text: string,
  selections: ReadonlyMap<string, string>,
): string[] {
  return resolveComposerMentions(text, [], selections).pubkeys;
}

const COMPOSER_MENTION_PATTERN = /@([\p{L}\p{M}\p{N}_-]+)/gu;
const MENTION_HANDLE_CHARACTER = /[\p{L}\p{M}\p{N}_.-]/u;

/**
 * Resolve every live mention in composer order.
 *
 * A picker selection is already an exact handle→pubkey binding and survives
 * an asynchronous roster refresh. A manually completed handle is live only
 * when it maps to exactly one current Room participant; ambiguous and unknown
 * tokens remain ordinary prose and must not produce either a p-tag or gold UI.
 */
export function resolveComposerMentions(
  text: string,
  participants: readonly MentionableParticipant[],
  selections: ReadonlyMap<string, string>,
): ResolvedComposerMentions {
  const selectedByHandle = new Map(
    [...selections].map(([handle, pubkey]) => [normalizeMentionSearch(handle), pubkey]),
  );
  const participantsByHandle = new Map<string, Set<string>>();
  for (const participant of participants) {
    const handle = normalizeMentionSearch(participant.handle);
    const pubkeys = participantsByHandle.get(handle) ?? new Set<string>();
    pubkeys.add(participant.pubkey);
    participantsByHandle.set(handle, pubkeys);
  }

  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const pubkeys: string[] = [];
  const handles: string[] = [];
  const seenPubkeys = new Set<string>();
  const seenHandles = new Set<string>();
  for (const match of normalized.matchAll(COMPOSER_MENTION_PATTERN)) {
    const offset = match.index ?? 0;
    const before = offset > 0 ? normalized[offset - 1]! : '';
    if (before && MENTION_HANDLE_CHARACTER.test(before)) continue;

    const handle = match[1] ?? '';
    const selectedPubkey = selectedByHandle.get(handle);
    const rosterPubkeys = participantsByHandle.get(handle);
    const pubkey =
      selectedPubkey ?? (rosterPubkeys?.size === 1 ? [...rosterPubkeys][0] : undefined);
    if (!pubkey) continue;
    if (!seenPubkeys.has(pubkey)) {
      seenPubkeys.add(pubkey);
      pubkeys.push(pubkey);
    }
    if (!seenHandles.has(handle)) {
      seenHandles.add(handle);
      handles.push(handle);
    }
  }
  return { pubkeys, handles };
}

/** Resolve the first visible @Agent name into the member pubkey written to the Nostr p-tag. */
export function mentionedAgentPubkey(text: string, agents: MentionableAgent[]): string | undefined {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const candidates = [...agents]
    .flatMap((agent) =>
      [agent.name, agent.handle]
        .filter((value): value is string => Boolean(value))
        .map((mention) => ({ agent, mention })),
    )
    .sort((a, b) => b.mention.length - a.mention.length);
  for (const agent of candidates) {
    const mention = `@${agent.mention.normalize('NFKC').toLocaleLowerCase()}`;
    let offset = normalized.indexOf(mention);
    while (offset >= 0) {
      const trailing = normalized[offset + mention.length];
      if (trailing === undefined || /[\s,.:;!?)}\]]/.test(trailing)) return agent.agent.pubkey;
      offset = normalized.indexOf(mention, offset + mention.length);
    }
  }
  return undefined;
}
