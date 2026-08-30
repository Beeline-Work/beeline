import type { RoomViewAgentTurn } from '@beeline/buzz-client';
import type { ChatDisplayMessage } from './room-view-presentation';

function belongsToActiveTurn(message: ChatDisplayMessage, turn: RoomViewAgentTurn): boolean {
  if (message.pubkey !== turn.agentPubkey || message.timestamp < turn.createdAt) return false;

  // Drafts carry the request identity directly in their stable presentation
  // id. Thoughts are session-scoped on the wire, so the signed turn's author
  // and start time are their narrowest client-side join; they are consumed by
  // this projection only so they can never become transcript rows. Indexed
  // activity is subject to the same author/time boundary and never enters the
  // live overlay decoder.
  if (message.id === `live-turn:${turn.requestId}`) return true;
  if (message.isAgentLiveTurn && message.agentThought) return true;
  return Boolean(message.isAgentActivity && !message.isAgentLiveTurn);
}

/**
 * Join the active turn's verified content lanes for presentation only.
 *
 * The Room response remains the authority for tool activity and the turn
 * receipt remains the authority for whether the join exists. When the receipt
 * settles this returns the original rows untouched: consequential activity
 * resumes its existing durable rendering and all other telemetry stays hidden.
 */
export function projectActiveTurnStream(
  messages: readonly ChatDisplayMessage[],
  turn: RoomViewAgentTurn | undefined,
  archived: boolean,
): readonly ChatDisplayMessage[] {
  if (!turn || archived || turn.status !== 'working') return messages;

  const sources = messages.filter((message) => belongsToActiveTurn(message, turn));
  if (!sources.length) return messages;

  const draft = [...sources]
    .reverse()
    .find((message) => message.id === `live-turn:${turn.requestId}`)?.agentMessageDraft;
  const activity = sources.flatMap((message) => message.activity ?? []);
  const sourceIds = new Set(sources.map((message) => message.id));
  if (!draft && !activity.length) {
    return messages.filter((message) => !sourceIds.has(message.id));
  }

  const timestamp = Math.max(turn.createdAt, ...sources.map((message) => message.timestamp));
  const liveTurn: ChatDisplayMessage = {
    id: `active-turn-stream:${turn.requestId}`,
    text: '',
    isUser: false,
    timestamp,
    pubkey: turn.agentPubkey,
    isAgentAuthor: true,
    isAgentActivity: true,
    isAgentLiveTurn: true,
    ...(activity.length ? { activity } : {}),
    ...(draft ? { agentMessageDraft: draft } : {}),
  };

  return [...messages.filter((message) => !sourceIds.has(message.id)), liveTurn].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
}
