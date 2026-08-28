import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  KIND_AGENT_DRAFT,
  TAG_AGENT_DRAFT,
  TAG_AGENT_PRESENCE,
  TAG_AGENT_THOUGHT,
} from './kinds.js';
import type { RoomViewMessage } from './room-view.js';

export type LiveOverlay =
  | { readonly kind: 'draft'; readonly key: string; readonly stableId: string; readonly agentPubkey: string; readonly requestId: string; readonly text?: string; readonly closed: boolean; readonly createdAt: number }
  | { readonly kind: 'thought'; readonly key: string; readonly agentPubkey: string; readonly sessionId: string; readonly text?: string; readonly closed: boolean; readonly createdAt: number }
  | { readonly kind: 'presence'; readonly key: string; readonly agentPubkey: string; readonly status: 'online' | 'offline'; readonly createdAt: number };

function exactTag(event: NostrEvent, name: string): string | undefined {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0]!.length === 2 ? matches[0]![1] : undefined;
}

/** Verifies and decodes only the three ephemeral lanes the UI renders live. */
export class LiveOverlayDecoder {
  private readonly newest = new Map<string, { readonly createdAt: number; readonly eventId: string }>();

  constructor(
    private readonly roomId: string,
    private readonly agentPubkeys: ReadonlySet<string>,
    private readonly acceptedScopeIds: ReadonlySet<string> = new Set([roomId]),
  ) {}

  decode(event: NostrEvent): LiveOverlay | null {
    if (event.kind !== KIND_AGENT_DRAFT || !verifyEvent(event)) return null;
    const marker = exactTag(event, 't');
    if (marker !== TAG_AGENT_DRAFT && marker !== TAG_AGENT_THOUGHT && marker !== TAG_AGENT_PRESENCE) {
      return null;
    }
    const agentPubkey = exactTag(event, 'agent');
    const scope = exactTag(event, 'h');
    const d = exactTag(event, 'd');
    if (agentPubkey !== event.pubkey || !this.agentPubkeys.has(event.pubkey) ||
      !scope || !this.acceptedScopeIds.has(scope) || d !== `${marker}:${this.roomId}`) return null;

    if (marker === TAG_AGENT_DRAFT) {
      const closed = exactTag(event, 'status') === 'closed';
      const requestId = exactTag(event, 'request');
      if (!closed && !requestId) return null;
      const key = `draft:${agentPubkey}:${requestId ?? '*'}`;
      if (!this.isNewest(`draft-lane:${agentPubkey}:${this.roomId}`, event)) return null;
      return {
        kind: 'draft', key, stableId: `live-turn:${requestId ?? agentPubkey}`,
        agentPubkey, requestId: requestId ?? '', ...(event.content.trim() ? { text: event.content } : {}),
        closed, createdAt: event.created_at,
      };
    }
    if (marker === TAG_AGENT_THOUGHT) {
      const sessionId = exactTag(event, 'session');
      if (!sessionId) return null;
      const key = `thought:${agentPubkey}:${sessionId}`;
      if (!this.isNewest(`thought-lane:${agentPubkey}:${this.roomId}`, event)) return null;
      return {
        kind: 'thought', key, agentPubkey, sessionId,
        ...(event.content.trim() ? { text: event.content } : {}),
        closed: exactTag(event, 'status') === 'closed', createdAt: event.created_at,
      };
    }
    const status = exactTag(event, 'status');
    if (status !== 'online' && status !== 'offline') return null;
    const key = `presence:${agentPubkey}:${this.roomId}`;
    if (!this.isNewest(key, event)) return null;
    return { kind: 'presence', key, agentPubkey, status, createdAt: event.created_at };
  }

  private isNewest(key: string, event: NostrEvent): boolean {
    const previous = this.newest.get(key);
    if (previous && (event.created_at < previous.createdAt ||
      (event.created_at === previous.createdAt && event.id <= previous.eventId))) return false;
    this.newest.set(key, { createdAt: event.created_at, eventId: event.id });
    return true;
  }
}

/** Route-local ephemeral replacement; durable DTO fields are never patched. */
export function applyLiveOverlay(
  current: readonly LiveOverlay[],
  update: LiveOverlay,
): readonly LiveOverlay[] {
  if (update.kind === 'draft') {
    const withoutAgentDraft = current.filter((item) =>
      item.kind !== 'draft' || item.agentPubkey !== update.agentPubkey);
    return update.closed ? withoutAgentDraft : [...withoutAgentDraft, update];
  }
  const withoutKey = current.filter((item) => item.key !== update.key);
  if ((update.kind === 'thought' && update.closed)) return withoutKey;
  return [...withoutKey, update];
}

export function visibleLiveOverlays(
  overlays: readonly LiveOverlay[],
  durable: readonly RoomViewMessage[],
): readonly LiveOverlay[] {
  const completed = new Set(durable.flatMap((message) =>
    message.requestId ? [`${message.author.pubkey}:${message.requestId}`] : []));
  return overlays.filter((overlay) => overlay.kind !== 'draft' ||
    !completed.has(`${overlay.agentPubkey}:${overlay.requestId}`));
}
