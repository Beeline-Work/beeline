import { resolveCornerCardAgentPubkey } from '@/buzz/agent-display';
import { cornerName } from '@/buzz/corners';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

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
 * The chat header's title, or `null` when the screen should show a skeleton.
 *
 * `resolvedName` is `null` only while the channel's own metadata read is still
 * in flight; an empty string means the read landed and the channel carries no
 * name, which is a different answer.
 *
 * A corner must never fall back to the word "Room": it names the wrong surface,
 * and because a corner's own kind:9007 name is a slug like `fix-oauth-callback`
 * the generic label is not even a plausible stand-in. When the channel kind
 * itself is still unresolved, neither word is honest, so this returns `null`
 * and the caller renders a skeleton instead of guessing.
 */
export function channelHeaderTitle(
  resolvedName: string | null,
  kind: ChannelKind,
  channelId: string,
): string | null {
  if (kind === 'corner') {
    return resolvedName === null ? null : cornerName(resolvedName, channelId);
  }
  if (resolvedName !== null && resolvedName.trim()) return resolvedName.trim();
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
  return resolveCornerCardAgentPubkey(declaredAgentPubkey, knownMessageSignerPubkey, isRegisteredAgent);
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

/** The durable agent response is the human-readable end-of-turn summary. */
export function latestCornerTurnSummary(
  messages: readonly ChatDisplayMessage[],
  agentPubkey?: string,
): string | undefined {
  const message = [...messages]
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .reverse()
    .find(
      (item) =>
        !item.isUser &&
        !item.agentTurn &&
        !item.isAgentActivity &&
        !item.corner &&
        !item.isMergeSummary &&
        !item.isArchivedNotice &&
        (!agentPubkey || item.pubkey === agentPubkey) &&
        Boolean(item.text.trim()),
    );
  return message?.text.trim();
}
