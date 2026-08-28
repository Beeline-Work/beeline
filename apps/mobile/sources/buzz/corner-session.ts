import { resolveCornerCardAgentPubkey } from '@/buzz/agent-display';
import { cornerName } from '@/buzz/corners';
import { displayCornerTitle, displayRoomIndexTitle } from '@/buzz/room-list-row';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import type { ChatDisplayMessage, CornerProcessState } from '@/buzz/room-view-presentation';

export type CornerSessionState = 'working' | 'idle' | 'done';

/**
 * What the chat screen knows about the channel it is showing before its own
 * metadata read lands. `unknown` is a real state — a notification deep link or
 * a cold first visit reaches the transcript with nothing but an id.
 */
export type ChannelKind = 'room' | 'corner' | 'unknown';

/**
 * Whether a locally cached channel entry already proves room-vs-corner.
 *
 * `parentChannelId` is written as `parentId ?? undefined`, so an absent value
 * means "room" only once the same patch has also written the resolved name;
 * before that it is indistinguishable from "never fetched".
 */
export function cachedChannelKind(
  cache: { parentChannelId?: string; roomName?: string } | undefined,
): ChannelKind {
  if (!cache) return 'unknown';
  if (cache.parentChannelId) return 'corner';
  return cache.roomName ? 'room' : 'unknown';
}

/**
 * The chat header's title under the captain's `#` channel-mark convention
 * (2026-08, extended to every surface): a Room renders `#<name>`, a Corner
 * renders `#<room>/<corner>` composed from stored names at render time.
 * Presentation only — the stored name, cache entries, and navigation params
 * never see the mark; see `displayRoomIndexTitle` / `displayCornerTitle` in
 * `buzz/room-list-row.ts` for the one naming model.
 *
 * `null` when the screen should show a skeleton. `resolvedName` is `null`
 * only while the channel's own metadata read is still in flight; an empty
 * string means the read landed and the channel carries no name, which is a
 * different answer.
 *
 * A corner must never fall back to the word "Room": it names the wrong
 * surface, and because a corner's own kind:9007 name is a slug like
 * `fix-oauth-callback` the generic label is not even a plausible stand-in.
 * When the channel kind itself is still unresolved, neither word is honest,
 * so this returns `null` and the caller renders a skeleton instead of
 * guessing. A DM's title is its peer's identity — a person, not a place —
 * so it never takes the mark (`options.directMessage`).
 */
export type ChannelTitleOptions = {
  /** A direct message renders its peer identity unmarked. */
  directMessage?: boolean;
  /**
   * The corner's parent Room STORED name, for the `#<room>/<corner>` form.
   * `undefined` when the channel is not a corner; `null` when it is a corner
   * whose parent Room name has not resolved yet (the header degrades to the
   * honest `#<corner>` rather than blocking on another read).
   */
  parentRoomName?: string | null;
};

export function channelHeaderTitle(
  resolvedName: string | null,
  kind: ChannelKind,
  channelId: string,
  options: ChannelTitleOptions = {},
): string | null {
  if (kind === 'corner') {
    if (resolvedName === null) return null;
    if (options.directMessage) return cornerName(resolvedName, channelId);
    return displayCornerTitle(options.parentRoomName, resolvedName, channelId);
  }
  if (resolvedName !== null && resolvedName.trim()) {
    const trimmed = resolvedName.trim();
    // The kind can still be unresolved while a cached name has landed; that
    // legacy shape keeps showing the plain name rather than guessing which
    // mark form applies. Only a confirmed Room takes the room mark.
    if (!options.directMessage && kind === 'room') return displayRoomIndexTitle(trimmed) ?? trimmed;
    return trimmed;
  }
  return kind === 'room' ? ROOM_LABEL : null;
}

/**
 * The corner view's own header identity. `agentTurn.agentPubkey` is declared
 * data (the same `agent` tag, or its signer fallback, that `corner.agentPubkey`
 * uses) and can be a stale/legacy pubkey even when a later message in the same
 * transcript is actually signed by the current registered agent. Apply the
 * same roster-preferring precedence the in-Room corner card uses
 * (`resolveCornerCardAgentPubkey`), so this surface can never show a
 * pubkey-hash placeholder name (e.g. "Alden") for an agent the transcript
 * already proves is registered (e.g. "Beebee").
 */
export function resolveCornerViewAgentPubkey(
  messages: readonly ChatDisplayMessage[],
  isRegisteredAgent: (pubkey: string) => boolean,
): string | undefined {
  const reversedMessages = [...messages].reverse();
  const declaredAgentPubkey = reversedMessages.find((message) => message.agentTurn)?.agentTurn
    ?.agentPubkey;
  const knownMessageSignerPubkey = reversedMessages.find(
    (message) => message.pubkey && isRegisteredAgent(message.pubkey),
  )?.pubkey;
  return resolveCornerCardAgentPubkey(
    declaredAgentPubkey,
    knownMessageSignerPubkey,
    isRegisteredAgent,
  );
}

/** The edit session lifecycle is authoritative for the corner, never daemon presence. */
export function cornerSessionState(messages: readonly ChatDisplayMessage[]): CornerSessionState {
  const latestTurn = [...messages]
    .filter((message) => message.agentTurn)
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .at(-1)?.agentTurn;
  if (!latestTurn) return 'idle';
  if (latestTurn.status === 'working') return 'working';
  return latestTurn.status === 'complete' ? 'done' : 'idle';
}
export function cornerProcessState(
  messages: readonly ChatDisplayMessage[],
): CornerProcessState | undefined {
  return [...messages]
    .filter((message) => message.cornerProcess)
    .sort(
      (a, b) =>
        (a.cornerProcess?.sequence ?? 0) - (b.cornerProcess?.sequence ?? 0) ||
        a.timestamp - b.timestamp ||
        a.id.localeCompare(b.id),
    )
    .at(-1)?.cornerProcess?.state;
}

/** How many changed paths the review card names before it counts the rest. */
export const CHANGE_REVIEW_SUMMARY_MAX_PATHS = 2;

/**
 * The review card's one line about the CHANGE — never about the agent's words.
 *
 * This slot used to render the corner's last agent message, which is the
 * concise reduction of narration the transcript already carries in full: the
 * same sentences printed a third time, right above the diff they were meant
 * to introduce. The transcript is the single source of truth for prose, so the
 * card describes what is actually up for review instead.
 *
 * `undefined` while the manifest has not loaded — "not known yet" is a
 * different answer from "nothing changed", and the caller renders its own
 * neutral line rather than a number it cannot stand behind.
 */
export function changeReviewSummary(
  files: readonly string[] | null | undefined,
): string | undefined {
  if (!files) return undefined;
  const paths = files.map((path) => path.trim()).filter(Boolean);
  if (!paths.length) return undefined;
  const named = paths.slice(0, CHANGE_REVIEW_SUMMARY_MAX_PATHS);
  const rest = paths.length - named.length;
  return rest > 0 ? `${named.join(', ')} +${rest} more` : named.join(', ');
}
