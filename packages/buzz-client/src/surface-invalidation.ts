import type { NostrEvent } from '@beeline/nostr';
import {
  KIND_AGENT_DRAFT,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_DELETE_GROUP,
  KIND_EDIT_METADATA,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  KIND_PERSON_PROFILE,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_DRAFT,
  TAG_AGENT_PRESENCE,
  TAG_AGENT_THOUGHT,
} from './kinds.js';

export type SurfaceScope =
  | { readonly kind: 'workspaces' }
  | { readonly kind: 'workspace'; readonly workspaceId: string; readonly profileAuthors: ReadonlySet<string> }
  | { readonly kind: 'chats'; readonly workspaceId: string; readonly roomIds: ReadonlySet<string>; readonly profileAuthors: ReadonlySet<string> }
  | { readonly kind: 'agent'; readonly workspaceId: string; readonly agentPubkey: string }
  | { readonly kind: 'room'; readonly roomId: string; readonly familyIds: ReadonlySet<string>; readonly profileAuthors: ReadonlySet<string> }
  | { readonly kind: 'corners'; readonly roomId: string; readonly cornerIds: ReadonlySet<string>; readonly profileAuthors: ReadonlySet<string> };

function tags(event: NostrEvent, name: string): string[] {
  return event.tags.flatMap((tag) => tag[0] === name && tag[1] ? [tag[1]] : []);
}

function hasLiveMarker(event: NostrEvent): boolean {
  return tags(event, 't').some((value) =>
    value === TAG_AGENT_DRAFT || value === TAG_AGENT_THOUGHT || value === TAG_AGENT_PRESENCE,
  );
}

/** Closed invalidation matrix. Overlay records never schedule a durable GET. */
export const SURFACE_INVALIDATION_MATRIX = Object.freeze({
  workspaces: 'workspace create/membership metadata',
  workspace: 'workspace membership, agent roster/model, and current roster profiles',
  chats: 'workspace/Room lifecycle and durable messages in listed Rooms',
  agent: 'selected agent roster, catalog, config, or profile',
  room: 'durable events in the open Room family and current member profiles',
  corners: 'corner lifecycle/durable events and current author profiles',
});

export function invalidatesSurface(event: NostrEvent, surface: SurfaceScope): boolean {
  if (hasLiveMarker(event)) return false;
  const h = new Set(tags(event, 'h'));
  const parents = new Set([...tags(event, 'parent'), ...tags(event, 'subchannel')]);
  const markers = new Set(tags(event, 't'));
  const isMembership = event.kind === KIND_PUT_USER || event.kind === KIND_REMOVE_USER ||
    event.kind === KIND_CHANNEL_ADMINS || event.kind === KIND_CHANNEL_MEMBERS;
  const isCreate = event.kind === KIND_CREATE_GROUP || event.kind === KIND_EDIT_METADATA ||
    event.kind === KIND_DELETE_GROUP;
  const isDurable = event.kind === KIND_STREAM_MESSAGE || event.kind === 30078 || isMembership || isCreate;
  const isProfile = event.kind === KIND_PERSON_PROFILE;

  switch (surface.kind) {
    case 'workspaces':
      return isMembership || isCreate;
    case 'workspace':
      return (isDurable && h.has(surface.workspaceId) &&
        (isMembership || isCreate || markers.has(TAG_AGENT) || markers.has('buzz-agent-model-catalog') ||
          markers.has('buzz-agent-model-config'))) ||
        (isProfile && surface.profileAuthors.has(event.pubkey));
    case 'agent':
      return (h.has(surface.workspaceId) &&
        (event.pubkey === surface.agentPubkey || tags(event, 'p').includes(surface.agentPubkey))) ||
        (isProfile && event.pubkey === surface.agentPubkey);
    case 'chats':
      return (isDurable && ([...h].some((id) => surface.roomIds.has(id)) || h.has(surface.workspaceId))) ||
        (isProfile && surface.profileAuthors.has(event.pubkey));
    case 'room':
      return (isDurable && ([...h].some((id) => surface.familyIds.has(id)) ||
        [...parents].some((id) => surface.familyIds.has(id)))) ||
        (isProfile && surface.profileAuthors.has(event.pubkey));
    case 'corners':
      return (isDurable && (h.has(surface.roomId) || [...h].some((id) => surface.cornerIds.has(id)) ||
        [...parents].some((id) => id === surface.roomId || surface.cornerIds.has(id)))) ||
        (isProfile && surface.profileAuthors.has(event.pubkey));
  }
}
