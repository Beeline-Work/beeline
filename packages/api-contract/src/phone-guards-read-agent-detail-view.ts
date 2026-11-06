import { readAgentUsage } from './agent-usage.js';
import { type AgentDetailView, type AgentPairingAbandonView, type AgentPairingClaimView, type AgentPairingClaimWireView, type InviteView } from './phone-types.js';
import { record, readMember, uuid, readList, nonempty, field, httpUrl, readIdentity, readWatchFilters, oneOf, readAgentGrantView, integer, hex64 } from './phone-guards.js';
import { readModelOption, readComposerCommand, readModelSelection, readAgentYolo, readAgentAccess } from './phone-guards-read-corner-lifecycle.js';



export function readAgentDetailView(value: unknown): AgentDetailView | null {
  const item = record(value);
  const agent = readMember(item?.agent);
  if (!item || !uuid(item.workspaceId) || !agent || agent.identity.kind !== 'agent') return null;
  const catalog = readList(item.catalog, readModelOption, 100) ?? [];
  const commands = readList(item.commands, readComposerCommand, 200) ?? [];
  const soul = record(item.soul);
  const projectedSoul =
    soul && nonempty(soul.name) && nonempty(soul.instructions) && nonempty(soul.avatarSeed)
      ? {
          name: soul.name,
          instructions: soul.instructions,
          avatarSeed: soul.avatarSeed,
          ...field('avatar', httpUrl(soul.avatar) ? soul.avatar : undefined),
        }
      : undefined;
  const owner = readIdentity(item.owner);
  const wake = record(item.wake);
  return {
    workspaceId: item.workspaceId,
    agent,
    ...field('wake', wake && (wake.url === null || httpUrl(wake.url)) && typeof wake.keySet === 'boolean'
      ? { url: wake.url as string | null, keySet: wake.keySet } : undefined),
    ...field('usage', readAgentUsage(item.usage)),
    ...field('harness', typeof item.harness === 'string' ? item.harness : undefined),
    ...field(
      'recentWorkCursor',
      nonempty(item.recentWorkCursor) ? item.recentWorkCursor : undefined,
    ),
    ...field(
      'avatarGenerationPending',
      typeof item.avatarGenerationPending === 'boolean' ? item.avatarGenerationPending : undefined,
    ),
    recentWork:
      readList(
        item.recentWork,
        (value) => {
          const work = record(value);
          return work &&
            nonempty(work.title) &&
            httpUrl(work.url) &&
            /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(work.url)
            ? { title: work.title, url: work.url }
            : null;
        },
        20,
      ) ?? [],
    catalog,
    commands,
    watchFilters: readWatchFilters(item.watchFilters),
    ...field('owner', owner && owner.kind === 'human' ? owner : undefined),
    ...field('soul', projectedSoul),
    ...field(
      'avatarGenerationId',
      nonempty(item.avatarGenerationId) ? item.avatarGenerationId : undefined,
    ),
    ...field('seededSoul', nonempty(item.seededSoul) ? item.seededSoul : undefined),
    ...field('runtimeSelection', readModelSelection(item.runtimeSelection)),
    ...field('selected', readModelSelection(item.selected)),
    ...field('modelUnavailable', oneOf(item.modelUnavailable, ['model', 'effort', 'selection'])),
    ...field('fastMode', typeof item.fastMode === 'boolean' ? item.fastMode : undefined),
    ...field('canLogin', typeof item.canLogin === 'boolean' ? item.canLogin : undefined),
    ...field('yolo', readAgentYolo(item.yolo)),
    ...field('access', readAgentAccess(item.access)),
    ...field('grants', readList(item.grants, readAgentGrantView)),
    ...field(
      'canManageGrants',
      typeof item.canManageGrants === 'boolean' ? item.canManageGrants : undefined,
    ),
  };
}


export function isAgentDetailView(value: unknown): value is AgentDetailView {
  return readAgentDetailView(value) !== null;
}


export function readInviteView(value: unknown): InviteView | null {
  const item = record(value);
  if (!item || typeof item.name !== 'string' || !integer(item.expiresAt)) return null;
  return {
    name: item.name,
    expiresAt: item.expiresAt,
    ...field('avatar', typeof item.avatar === 'string' ? item.avatar : undefined),
    ...field(
      'joinedWorkspaceId',
      typeof item.joinedWorkspaceId === 'string' ? item.joinedWorkspaceId : undefined,
    ),
    ...field('inviter', readInviteInviter(item.inviter)),
    ...field('memberCount', integer(item.memberCount) ? item.memberCount : undefined),
    ...field('agentCount', integer(item.agentCount) ? item.agentCount : undefined),
  };
}


function readInviteInviter(value: unknown): InviteView['inviter'] {
  const item = record(value);
  if (!item || typeof item.name !== 'string') return undefined;
  const role = item.role;
  const roleValue: NonNullable<InviteView['inviter']>['role'] =
    role === 'owner' || role === 'admin' || role === 'member' || role === 'spectator'
      ? role
      : undefined;
  return {
    name: item.name,
    ...field('handle', typeof item.handle === 'string' ? item.handle : undefined),
    ...field('face', typeof item.face === 'string' ? item.face : undefined),
    ...field('role', roleValue),
  };
}


export function isInviteView(value: unknown): value is InviteView {
  return readInviteView(value) !== null;
}


export function readAgentPairingClaimWireView(value: unknown): AgentPairingClaimWireView | null {
  const item = record(value);
  if (
    !item ||
    !uuid(item.workspaceId) ||
    !hex64(item.pairedBy) ||
    typeof item.joined !== 'boolean'
  ) {
    return null;
  }
  return {
    workspaceId: item.workspaceId,
    pairedBy: item.pairedBy,
    joined: item.joined,
    ...field(
      'attachedRoomIds',
      Array.isArray(item.attachedRoomIds)
        ? item.attachedRoomIds.filter((roomId): roomId is string => uuid(roomId))
        : undefined,
    ),
  };
}


export function readAgentPairingClaimView(value: unknown): AgentPairingClaimView | null {
  const wire = readAgentPairingClaimWireView(value);
  if (!wire) return null;
  return { ...wire, attachedRoomIds: wire.attachedRoomIds ?? [] };
}


export function readAgentPairingAbandonView(value: unknown): AgentPairingAbandonView | null {
  const item = record(value);
  if (!item || typeof item.abandoned !== 'boolean') return null;
  return { abandoned: item.abandoned };
}


/** A message link reveals only member-readable coordinates. */
export function readMessageLinkView(value: unknown): { roomId: string; messageId: string; workspaceId: string } | null {
  const item = record(value);
  return item && typeof item.roomId === 'string' && typeof item.workspaceId === 'string'
    && typeof item.messageId === 'string' && /^[0-9a-f]{64}$/.test(item.messageId)
    ? { roomId: item.roomId, messageId: item.messageId, workspaceId: item.workspaceId } : null;
}
