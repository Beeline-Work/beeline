export type MentionableAgent = { pubkey: string; name: string; handle?: string };
type RoomRosterMember = { pubkey: string };
type RoomParticipant = RoomRosterMember & { kind: 'person' | 'agent' };

export function shouldReadWorkspaceRoster({
  activeWorkspaceId,
  cachedWorkspaceId,
  rosterSurfaceVisible,
}: {
  activeWorkspaceId?: string | null;
  cachedWorkspaceId?: string | null;
  rosterSurfaceVisible: boolean;
}): boolean {
  if (!activeWorkspaceId) return false;
  return rosterSurfaceVisible || cachedWorkspaceId !== activeWorkspaceId;
}

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

/**
 * The authoritative Room roster as ONE list: people in membership order, agents
 * after. The sheet heads and counts that single list — the viewer among them,
 * since the viewer is a member of the Room they are reading — so no member
 * falls between two sections and no count disagrees with another.
 */
export function orderRoomRoster<T extends RoomParticipant>(participants: readonly T[]): T[] {
  return [
    ...participants.filter((participant) => participant.kind !== 'agent'),
    ...participants.filter((participant) => participant.kind === 'agent'),
  ];
}

/**
 * Collapsed roster length. Ten rows fill the sheet on a phone and still leave
 * the overflow row on screen; the head keeps the true total beside the word,
 * so a Room with more members says so before anyone scrolls.
 */
export const ROOM_ROSTER_VISIBLE_ROWS = 10;

export type RoomRosterWindow<T> = {
  readonly visible: readonly T[];
  readonly hidden: number;
  readonly overflowLabel: string | null;
};

export function roomRosterWindow<T>(
  members: readonly T[],
  expanded: boolean,
  cap = ROOM_ROSTER_VISIBLE_ROWS,
): RoomRosterWindow<T> {
  if (expanded) return { visible: members, hidden: 0, overflowLabel: null };
  const visible = members.slice(0, Math.max(0, cap));
  const hidden = Math.max(0, members.length - visible.length);
  return { visible, hidden, overflowLabel: hidden > 0 ? `${hidden} more` : null };
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
  return resolveComposerMentions(text, [], selections).pubkeys[0];
}

/** Resolve every picker-selected mention whose handle is still present in the sent text. */
export function selectedMentionPubkeys(
  text: string,
  selections: ReadonlyMap<string, string>,
): string[] {
  return resolveComposerMentions(text, [], selections).pubkeys;
}

const COMPOSER_MENTION_PATTERN = /@([\p{L}\p{M}\p{N}_]+(?:[.-][\p{L}\p{M}\p{N}_]+)*)/gu;
const MENTION_HANDLE_CHARACTER = /[\p{L}\p{M}\p{N}_.-]/u;

function mentionCodePointBefore(text: string, offset: number): string | undefined {
  if (!offset) return undefined;
  const last = text.charCodeAt(offset - 1);
  const start = last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1;
  const codePoint = text.codePointAt(start);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function mentionCodePointAt(text: string, offset: number): string | undefined {
  const codePoint = text.codePointAt(offset);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

/**
 * `@channel` is the one reserved broadcast token: never a resolvable
 * identity, so it never earns a picker selection or a p-tag pubkey. Handles
 * reaching this check are already NFKC/lowercase-normalized (composer text
 * and server-derived handles alike), so a plain equality is case-insensitive.
 */
export const CHANNEL_MENTION_HANDLE = 'channel';
/** Sentinel roster pubkey for the synthetic `@channel` autocomplete row — never a real identity. */
export const CHANNEL_MENTION_PUBKEY = '@channel';

export function isChannelMentionHandle(handle: string): boolean {
  return normalizeMentionSearch(handle) === CHANNEL_MENTION_HANDLE;
}

/** Every literal, live mention token in composer/tokenizer order (lowercased handles). */
function typedComposerMentionTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const handles: string[] = [];
  for (const match of normalized.matchAll(COMPOSER_MENTION_PATTERN)) {
    const offset = match.index ?? 0;
    const before = mentionCodePointBefore(normalized, offset);
    if (before && MENTION_HANDLE_CHARACTER.test(before)) continue;
    const punctuation = normalized.slice(offset + match[0].length).match(/^[.-]+/u)?.[0];
    const afterPunctuation = punctuation
      ? mentionCodePointAt(normalized, offset + match[0].length + punctuation.length)
      : undefined;
    if (afterPunctuation && MENTION_HANDLE_CHARACTER.test(afterPunctuation)) continue;
    handles.push(match[1] ?? '');
  }
  return handles;
}

/** Whether the composer/sent text addresses the whole Room via a live `@channel` token. */
export function hasChannelMentionToken(text: string): boolean {
  return typedComposerMentionTokens(text).some(isChannelMentionHandle);
}

/**
 * Resolve every live mention in composer order.
 *
 * A picker selection is already an exact handle→pubkey binding and survives
 * an asynchronous roster refresh. A manually completed handle is live only
 * when it maps to exactly one current Room participant; ambiguous and unknown
 * tokens remain ordinary prose and must not produce either a p-tag or gold UI.
 * `@channel` never resolves to a pubkey here — it is a broadcast, not an
 * addressable identity — even when a stray selection or roster entry shares
 * its literal handle.
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
    const handle = normalizeMentionSearch(participant.handle.replace(/^@/, ''));
    if (!handle) continue;
    const pubkeys = participantsByHandle.get(handle) ?? new Set<string>();
    pubkeys.add(participant.pubkey);
    participantsByHandle.set(handle, pubkeys);
  }

  const pubkeys: string[] = [];
  const handles: string[] = [];
  const seenPubkeys = new Set<string>();
  const seenHandles = new Set<string>();
  for (const handle of typedComposerMentionTokens(text)) {
    if (isChannelMentionHandle(handle)) continue;
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

/** Resolve the first exact visible agent @handle into the member pubkey written to the Nostr p-tag. */
export function mentionedAgentPubkey(text: string, agents: MentionableAgent[]): string | undefined {
  const participants = agents.flatMap((agent) =>
    agent.handle ? [{ pubkey: agent.pubkey, name: agent.name, handle: agent.handle }] : [],
  );
  return resolveComposerMentions(text, participants, new Map()).pubkeys[0];
}
