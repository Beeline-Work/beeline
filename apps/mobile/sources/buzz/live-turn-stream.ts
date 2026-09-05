import { visibleLiveOverlays, type LiveOverlay, type RoomViewAgentTurn, type RoomViewMessage } from '@beeline/buzz-client';
import { joinedTurnRowId, liveDraftRowId } from './draft-settle';
import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * The transcript rows the ephemeral draft lanes paint.
 *
 * ONE row per streaming agent, named by author AND request (`liveDraftRowId`),
 * standing at the stamp its turn started at (`applyLiveOverlay` anchors it).
 * Two agents streaming at once therefore hold two adjacent slots in turn-start
 * order and each is edited in place; neither can take the other's row.
 *
 * Draft prose is the only live transcript overlay. Presence drives its own
 * indicator, and private thought text never enters message rows.
 */
export function liveDraftMessages(
  overlays: readonly LiveOverlay[],
  durable: readonly RoomViewMessage[],
): ChatDisplayMessage[] {
  return visibleLiveOverlays(overlays, durable).flatMap((overlay) => {
    if (overlay.kind !== 'draft') return [];
    return [
      {
        id: liveDraftRowId(overlay.agentPubkey, overlay.requestId),
        text: overlay.text ?? '',
        isUser: false,
        timestamp: overlay.createdAt,
        pubkey: overlay.agentPubkey,
        isAgentAuthor: true,
        isAgentActivity: true,
        // A settled draft (retracted, final not yet arrived) keeps its text
        // but stops pulsing as the live turn.
        isAgentLiveTurn: !overlay.closed,
        isAgentDraft: true,
        agentMessageDraft: overlay.text ?? '',
      },
    ];
  });
}

function belongsToActiveTurn(message: ChatDisplayMessage, turn: RoomViewAgentTurn): boolean {
  if (message.pubkey !== turn.agentPubkey) return false;

  // Drafts carry the request identity directly in their stable presentation
  // id, so no clock has to vouch for them — and none may: the row is anchored
  // to its turn start while `turn.createdAt` is refreshed by every heartbeat
  // receipt, so a time guard would disown the draft mid-turn. Thoughts are
  // session-scoped on the wire, so the signed turn's author and start time are
  // their narrowest client-side join; they are consumed by this projection
  // only so they can never become transcript rows. Indexed activity is subject
  // to the same author/time boundary and never enters the live overlay decoder.
  if (message.id === liveDraftRowId(turn.agentPubkey, turn.requestId)) return true;
  if (message.timestamp < turn.createdAt) return false;
  if (message.isAgentLiveTurn && message.agentThought) return true;
  return Boolean(message.isAgentActivity && !message.isAgentLiveTurn);
}

/**
 * Join each active turn's verified content lanes for presentation only.
 *
 * Every working turn in the Room gets its own lane — two agents answering at
 * once are two speakers, not one — and a row is claimed by exactly one of
 * them. The Room response remains the authority for tool activity and the turn
 * receipt remains the authority for whether the join exists. When the receipt
 * settles this returns the original rows untouched: consequential activity
 * resumes its existing durable rendering and all other telemetry stays hidden.
 */
export function projectActiveTurnStream(
  messages: readonly ChatDisplayMessage[],
  turns: readonly RoomViewAgentTurn[],
  archived: boolean,
): readonly ChatDisplayMessage[] {
  if (archived) return messages;

  const consumed = new Set<string>();
  const lanes: ChatDisplayMessage[] = [];
  for (const turn of turns) {
    if (turn.status !== 'working') continue;
    const sources = messages.filter(
      (message) => !consumed.has(message.id) && belongsToActiveTurn(message, turn),
    );
    if (!sources.length) continue;
    for (const source of sources) consumed.add(source.id);

    const draft = [...sources]
      .reverse()
      .find((message) => message.id === liveDraftRowId(turn.agentPubkey, turn.requestId))
      ?.agentMessageDraft;
    const activity = sources.flatMap((message) => message.activity ?? []);
    if (!draft && !activity.length) continue;

    lanes.push({
      id: joinedTurnRowId(turn.agentPubkey, turn.requestId),
      text: '',
      isUser: false,
      // The lane holds the slot the turn started in — the earliest row it
      // absorbed. Never `turn.createdAt`: a heartbeat receipt refreshes that
      // stamp, which walked the lane to the tail on every beat and let a
      // second agent's lane leapfrog it.
      timestamp: Math.min(...sources.map((message) => message.timestamp)),
      pubkey: turn.agentPubkey,
      isAgentAuthor: true,
      isAgentActivity: true,
      isAgentLiveTurn: true,
      ...(activity.length ? { activity } : {}),
      ...(draft ? { agentMessageDraft: draft } : {}),
    });
  }
  if (!consumed.size) return messages;

  return [...messages.filter((message) => !consumed.has(message.id)), ...lanes].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
}
