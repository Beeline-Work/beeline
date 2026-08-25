/**
 * Explicit `#room` / `#room/corner` references in conversation prose.
 *
 * The shipped channel-mark convention (push-notification titles and Room
 * index rows both render `#<name>` via one presentation-only derivation) made
 * `#name` the product's written form for "a place". This module turns an
 * authored `#name` or `#room/corner` token in a message into a navigation
 * target — but ONLY when the token names a channel this workspace actually
 * has:
 *
 * - Resolution is exact against a caller-supplied index of known rooms and
 *   corners. Nothing is synthesized, no fuzzy match, no cross-Workspace read.
 *   An unknown token stays ordinary text.
 * - Ambiguity never guesses: if duplicate display names make one token map to
 *   more than one target, nothing is emitted.
 * - Longest complete reference wins, so a unique `#room/corner` is not
 *   degraded into a room link plus `/corner` text; conversely `#room/unknown`
 *   suppresses the room link entirely rather than slicing the token apart.
 * - The matching is literal prefix comparison on case-folded candidates.
 *   NO regex is ever built from a room name — untrusted names containing `.`,
 *   `*`, `(`, `$`, backslashes and friends are matched byte-for-byte and can
 *   neither widen the match nor blow up matching time.
 *
 * Pure and deterministic: no React Native, no store, no relay. The index is
 * assembled at the presentation/navigation boundary (the chat screen, from
 * the workspace's already-known channels); nothing here persists a second
 * channel index or mutates any stored name.
 */

export type ChannelReferenceTarget =
  | { readonly kind: 'room'; readonly channelId: string }
  | {
      readonly kind: 'corner';
      readonly channelId: string;
      readonly parentChannelId: string;
    };

export type ChannelReferenceRoomInput = {
  channelId: string;
  /** Stored display name, WITHOUT the `#` mark. */
  name: string;
};

export type ChannelReferenceCornerInput = {
  channelId: string;
  parentChannelId: string;
  /** Stored corner display name, WITHOUT the `#` mark or the `<room>/` part. */
  name: string;
};

export type ChannelReferenceIndex = {
  readonly rooms: readonly ChannelReferenceRoomInput[];
  readonly corners: readonly (ChannelReferenceCornerInput & { readonly roomName: string })[];
};

export type ChannelReferenceMatch = {
  /** The exact authored characters of the whole reference, e.g. `#Roadmap`. */
  readonly text: string;
  /** Inclusive start offset into the source text. */
  readonly start: number;
  /** Exclusive end offset into the source text. */
  readonly end: number;
  readonly target: ChannelReferenceTarget;
};

/**
 * Build the workspace-scoped lookup index. Duplicate ids keep their first
 * entry; entries with empty names are dropped; corners whose parent Room is
 * absent from `rooms` are skipped (a corner reference is written through its
 * room's name, so an unnameable parent can never resolve).
 */
export function buildChannelReferenceIndex(
  rooms: readonly ChannelReferenceRoomInput[],
  corners: readonly ChannelReferenceCornerInput[],
): ChannelReferenceIndex {
  const roomById = new Map<string, ChannelReferenceRoomInput>();
  const dedupedRooms: ChannelReferenceRoomInput[] = [];
  for (const room of rooms) {
    if (!room.channelId || !room.name.trim()) continue;
    if (roomById.has(room.channelId)) continue;
    roomById.set(room.channelId, room);
    dedupedRooms.push(room);
  }
  const seenCorners = new Set<string>();
  const resolvedCorners: (ChannelReferenceCornerInput & { roomName: string })[] = [];
  for (const corner of corners) {
    if (!corner.channelId || !corner.parentChannelId || !corner.name.trim()) continue;
    if (seenCorners.has(corner.channelId)) continue;
    const parent = roomById.get(corner.parentChannelId);
    if (!parent) continue;
    seenCorners.add(corner.channelId);
    resolvedCorners.push({ ...corner, roomName: parent.name });
  }
  return { rooms: dedupedRooms, corners: resolvedCorners };
}

/** Case-fold for comparison only; offsets never ride the folded value. */
function fold(value: string): string {
  return value.toLocaleLowerCase();
}

/**
 * Case-insensitive literal prefix test at an exact offset. Length-preserving
 * comparison: the compared slice must have exactly the candidate's length, so
 * a fold that changes length simply fails to match (conservative, and it keeps
 * every reported offset valid in the ORIGINAL string).
 */
function matchesAt(text: string, at: number, candidate: string): boolean {
  const end = at + candidate.length;
  if (end > text.length) return false;
  return (
    fold(text.slice(at, end)) === candidate &&
    // Guard the exotic case where lowercasing changed the slice's length:
    // the folded comparison above could then compare unequal-length strings
    // that still coerce equal. Exact length is part of the contract.
    text.slice(at, end).length === candidate.length
  );
}

/** A `#` glued to a word (`foo#bar`) is prose, not a reference. */
const BLOCKED_BEFORE = /[A-Za-z0-9_#\/]/;

/**
 * What may legitimately follow a COMPLETE reference: end of text, whitespace,
 * sentence punctuation, or closing quotes/brackets. Anything else (letters,
 * digits, `-`, `_`, `/`, `+`, …) means the authored token continues past the
 * matched name and the match would slice a longer token apart — so nothing is
 * linked. Deliberately narrow: staying ordinary text is always safe.
 */
const ALLOWED_AFTER = /[\s.,;:!?)\]}'"’”»…]/;

type Candidate = {
  token: string;
  length: number;
  target: ChannelReferenceTarget;
};

function collectCandidates(index: ChannelReferenceIndex): Candidate[] {
  const candidates: Candidate[] = [];
  const seenRooms = new Set<string>();
  for (const room of index.rooms) {
    if (seenRooms.has(room.channelId)) continue;
    seenRooms.add(room.channelId);
    candidates.push({
      token: `#${fold(room.name)}`,
      length: room.name.length + 1,
      target: { kind: 'room', channelId: room.channelId },
    });
  }
  const seenCorners = new Set<string>();
  for (const corner of index.corners) {
    if (seenCorners.has(corner.channelId)) continue;
    seenCorners.add(corner.channelId);
    candidates.push({
      token: `#${fold(corner.roomName)}/${fold(corner.name)}`,
      length: corner.roomName.length + corner.name.length + 2,
      target: {
        kind: 'corner',
        channelId: corner.channelId,
        parentChannelId: corner.parentChannelId,
      },
    });
  }
  return candidates;
}

/**
 * Find every explicit, resolvable channel reference in `text`, left to right,
 * non-overlapping. Unknown, ambiguous, boundary-broken, and degraded tokens
 * produce nothing — they remain ordinary text upstream.
 */
export function findChannelReferences(
  text: string,
  index: ChannelReferenceIndex,
): ChannelReferenceMatch[] {
  if (!text || text.indexOf('#') < 0) return [];
  const candidates = collectCandidates(index);
  if (candidates.length === 0) return [];
  const matches: ChannelReferenceMatch[] = [];
  let scanFrom = 0;
  while (scanFrom < text.length) {
    const hash = text.indexOf('#', scanFrom);
    if (hash < 0) break;
    scanFrom = hash + 1;
    if (hash > 0 && BLOCKED_BEFORE.test(text[hash - 1]!)) continue;

    // Longest complete reference wins; ties across DISTINCT targets are
    // ambiguous and link nothing.
    let bestLength = 0;
    for (const candidate of candidates) {
      if (candidate.length <= bestLength) continue;
      if (matchesAt(text, hash, candidate.token)) bestLength = candidate.length;
    }
    if (bestLength === 0) continue;
    let bestTarget: ChannelReferenceTarget | undefined;
    let ambiguous = false;
    for (const candidate of candidates) {
      if (candidate.length !== bestLength) continue;
      if (!matchesAt(text, hash, candidate.token)) continue;
      if (!bestTarget) {
        bestTarget = candidate.target;
        continue;
      }
      // Duplicate display names: two different channels own this token.
      if (candidate.target.channelId !== bestTarget.channelId) {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous || !bestTarget) continue;

    const after = hash + bestLength;
    if (after < text.length) {
      const next = text[after]!;
      if (!ALLOWED_AFTER.test(next)) continue;
      // A room immediately followed by `/…` reads as a corner reference that
      // did not resolve. Linking just the room would publish half a token as
      // a place and strand the rest as text — suppress the whole token.
      if (bestTarget.kind === 'room' && next === '/') continue;
    }
    matches.push({ text: text.slice(hash, after), start: hash, end: after, target: bestTarget });
    scanFrom = after;
  }
  return matches;
}
