import { readAgentUsage } from './agent-usage.js';
import { isAgentSignInHarness, isAgentSignInKeyProvider } from './agent-sign-in.js';
import { type AgentGrantView, type ChoiceCardView, type GrantRequestCardView, type RoomViewActivity, type RoomViewHeader, type RoomViewIdentity, type RoomViewMember, type RoomViewMessage, type RoomViewer, type SurfaceWatchFilter, type WorkspaceAgentView, type WorkspaceMemberGrantView } from './phone-types.js';
import { isAgentGrantKind, isAgentGrantStatus, isCommandGrantScript } from './agent-grants.js';
import { isConnectorOfferIntent, isConnectorOfferStatus, type ConnectorOfferCardView } from './connector-offers.js';
import { isConnectorKind } from './workbench.js';
import { CHOICE_LETTERS } from './room-choices.js';
export { readRoomViewMessage, isRoomViewMessage } from './phone-guards-read-choice-card.js';
export { readRoomView, isRoomView, readRoomHistoryView, readMessageSearchView, readRoomHistoryOutline, readWorkspaceListView, isWorkspaceListView, readWorkspaceView, isWorkspaceView, readWorkspaceMemberListView, isWorkspaceMemberListView, readChatListView, isChatListView, readCornerListView, isCornerListView } from './phone-guards-read-corner-lifecycle.js';
export { readAgentDetailView, isAgentDetailView, readInviteView, isInviteView, readAgentPairingClaimWireView, readAgentPairingClaimView, readAgentPairingAbandonView, readMessageLinkView } from './phone-guards-read-agent-detail-view.js';



/**
 * Phone surface readers project a known-safe view from a wire payload.
 *
 * A Room (and every other view in this file) must survive an unknown field and
 * a missing optional one. Unrecognised or unreadable list entries are dropped.
 * Only load-bearing identity fails the view — for a Room, that is `room.id`
 * and the presence of a `messages` array. `is*` remains `read*(value) !== null`
 * so existing type-predicate call sites still compile; HTTP clients apply
 * `read*` so a dropped row cannot linger as typed junk.
 */
export type SurfaceReader<T> = (value: unknown) => T | null;


export const HEX = /^[0-9a-f]{64}$/;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const SHA1 = /^[0-9a-f]{40}$/i;

export const WATCH_FILTER_LIMIT = 32;

export const WATCH_FILTER_TAG_KEYS: readonly string[] = ['authors', '#h', '#d', '#p', '#t'];

export const CLOSED_VIEWER: RoomViewer = {
  identity: { pubkey: '0'.repeat(64), kind: 'human', name: '' },
  role: 'member',
  permissions: { send: false, manage: false },
};


export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}


export function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}


export function hex64(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}


export function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}


export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}


export function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}


export function githubUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}


export function field<K extends string, V>(
  key: K,
  value: V | undefined | null,
): { [P in K]?: Exclude<V, undefined> } {
  return value === undefined || value === null
    ? {}
    : ({ [key]: value } as { [P in K]: Exclude<V, undefined> });
}


export function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}


export function readList<T>(value: unknown, read: SurfaceReader<T>, limit?: number): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (!item) continue;
    items.push(item);
    if (limit !== undefined && items.length >= limit) break;
  }
  return items;
}


export function requireList<T>(value: unknown, read: SurfaceReader<T>, limit?: number): T[] | null {
  return Array.isArray(value) ? (readList(value, read, limit) ?? []) : null;
}


/**
 * The server emits message rows oldest-first and already trims its own tail, so
 * a bundle whose cap is lower than the server's must keep the NEWEST rows.
 */
export function readNewestList<T>(value: unknown, read: SurfaceReader<T>, limit: number): T[] | undefined {
  return Array.isArray(value) ? (readList(value.slice(-limit), read) ?? []) : undefined;
}


export function readIdentity(value: unknown): RoomViewIdentity | null {
  const item = record(value);
  if (!item || !hex64(item.pubkey)) return null;
  if (item.kind !== 'human' && item.kind !== 'agent') return null;
  if (typeof item.name !== 'string') return null;
  return {
    pubkey: item.pubkey,
    kind: item.kind,
    name: item.name,
    ...field('handle', typeof item.handle === 'string' ? item.handle : undefined),
    ...field('avatar', typeof item.avatar === 'string' ? item.avatar : undefined),
    ...field('face', typeof item.face === 'string' ? item.face : undefined),
  };
}


export function readHeader(value: unknown): RoomViewHeader | null {
  const item = record(value);
  if (!item || !uuid(item.id)) return null;
  const reviewerAgentId = hex64(item.reviewerAgentId) ? item.reviewerAgentId : undefined;
  const parentId = uuid(item.parentId) ? item.parentId : undefined;
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    ...field('archived', typeof item.archived === 'boolean' ? item.archived : undefined),
    ...field('createdAt', integer(item.createdAt) ? item.createdAt : undefined),
    ...field('updatedAt', integer(item.updatedAt) ? item.updatedAt : undefined),
    ...field('workspaceId', uuid(item.workspaceId) ? item.workspaceId : undefined),
    ...field('parentId', parentId),
    ...field('about', typeof item.about === 'string' ? item.about : undefined),
    ...field('avatar', typeof item.avatar === 'string' ? item.avatar : undefined),
    ...field('visibility', oneOf(item.visibility, ['public', 'invite-only'])),
    ...field('reviewerAgentId', reviewerAgentId),
  };
}


export function readPresence(value: unknown): RoomViewMember['presence'] | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (item.status !== 'online' && item.status !== 'offline') return undefined;
  if (!integer(item.observedAt)) return undefined;
  return {
    status: item.status,
    observedAt: item.observedAt,
    ...field('held', item.held === true ? (true as const) : undefined),
    ...field('roomId', uuid(item.roomId) ? item.roomId : undefined),
  };
}


export function readMember(value: unknown): RoomViewMember | null {
  const item = record(value);
  const identity = readIdentity(item?.identity);
  if (!item || !identity) return null;
  const role = typeof item.role === 'string' && item.role.length > 0 ? item.role : 'member';
  return {
    identity,
    role: role as RoomViewMember['role'],
    ...field('model', identity.kind === 'agent' && typeof item.model === 'string' ? item.model : undefined),
    ...field('presence', readPresence(item.presence)),
  };
}


export function readWorkspaceAgent(value: unknown): WorkspaceAgentView | null {
  const member = readMember(value);
  const item = record(value);
  if (!member || !item || member.identity.kind !== 'agent') return null;
  const owner = readIdentity(item.owner);
  return {
    ...member,
    ...field('usage', readAgentUsage(item.usage)),
    ...field('model', typeof item.model === 'string' ? item.model : undefined),
    ...field('owner', owner && owner.kind === 'human' ? owner : undefined),
  };
}


export function readPermissions(value: unknown): RoomViewer['permissions'] | undefined {
  const item = record(value);
  if (!item || typeof item.send !== 'boolean' || typeof item.manage !== 'boolean') return undefined;
  return { send: item.send, manage: item.manage };
}


export function readViewer(value: unknown): RoomViewer {
  const item = record(value);
  const identity = readIdentity(item?.identity);
  const permissions = readPermissions(item?.permissions);
  if (!item || !identity || !permissions) return CLOSED_VIEWER;
  const role = typeof item.role === 'string' && item.role.length > 0 ? item.role : 'member';
  const cursor = record(item.readCursor);
  const readCursor =
    cursor &&
    (cursor.messageId === null || typeof cursor.messageId === 'string') &&
    (cursor.firstUnreadMessageId === null || typeof cursor.firstUnreadMessageId === 'string')
      ? {
          messageId: cursor.messageId as string | null,
          firstUnreadMessageId: cursor.firstUnreadMessageId as string | null,
          ...field(
            'unreadCount',
            integer(cursor.unreadCount) && cursor.unreadCount >= 0 ? cursor.unreadCount : undefined,
          ),

        }
      : undefined;
  return {
    identity,
    role: role as RoomViewer['role'],
    permissions,
    ...field('readCursor', readCursor),
    ...(item.pushMuted === true ? { pushMuted: true as const } : {}),
  };
}


export function readIdentityOnly(value: unknown): RoomViewIdentity | undefined {
  return readIdentity(value) ?? undefined;
}


export function readWatchFilter(value: unknown): SurfaceWatchFilter | null {
  const item = record(value);
  if (!item) return null;
  const filter: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(item)) {
    if (key === 'kinds') {
      if (!Array.isArray(entry) || !entry.every(integer)) return null;
    } else if (WATCH_FILTER_TAG_KEYS.includes(key)) {
      if (!Array.isArray(entry) || !entry.every((tag) => typeof tag === 'string')) return null;
    } else {
      return null;
    }
    filter[key] = entry;
  }
  return Object.keys(filter).length > 0 ? (filter as SurfaceWatchFilter) : null;
}


export function readWatchFilters(value: unknown): SurfaceWatchFilter[] {
  return readList(value, readWatchFilter, WATCH_FILTER_LIMIT) ?? [];
}


export function readAttachment(
  value: unknown,
): NonNullable<RoomViewMessage['attachments']>[number] | null {
  const item = record(value);
  if (
    !item ||
    !httpUrl(item.url) ||
    !nonempty(item.name) ||
    typeof item.mimeType !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(item.mimeType) ||
    !integer(item.size)
  ) {
    return null;
  }
  return {
    url: item.url,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    ...field('expired', typeof item.expired === 'boolean' ? item.expired : undefined),
    ...field('previewUrl', httpUrl(item.previewUrl) ? item.previewUrl : undefined),
    ...field('thumbnailUrl', httpUrl(item.thumbnailUrl) ? item.thumbnailUrl : undefined),
    ...field('sha256', hex64(item.sha256) ? item.sha256 : undefined),
    ...field('width', integer(item.width) && item.width > 0 ? item.width : undefined),
    ...field('height', integer(item.height) && item.height > 0 ? item.height : undefined),
    ...field('kind', oneOf(item.kind, ['artifact'])),
    ...field('title', typeof item.title === 'string' ? item.title : undefined),
    ...field('author', typeof item.author === 'string' ? item.author : undefined),
  };
}


export function readActivityRequester(
  value: unknown,
): NonNullable<RoomViewActivity['requestedBy']> | undefined {
  const item = record(value);
  if (!item || !hex64(item.pubkey)) return undefined;
  return {
    pubkey: item.pubkey,
    ...field('name', typeof item.name === 'string' ? item.name : undefined),
  };
}


export function readToolReference(value:unknown): import('./phone-types.js').RoomToolReference|undefined {
  const item=record(value);
  return item&&typeof item.roomId==='string'&&/^[0-9a-f-]{36}$/.test(item.roomId)&&
    typeof item.anchor==='string'&&item.anchor.length>0&&item.anchor.length<=128?{roomId:item.roomId,anchor:item.anchor}:undefined;
}

export function readActivity(value: unknown): RoomViewActivity | null {
  const item = record(value);
  if (
    !item ||
    (item.kind !== 'thinking' &&
      item.kind !== 'tool' &&
      item.kind !== 'output' &&
      item.kind !== 'summary') ||
    typeof item.title !== 'string'
  ) {
    return null;
  }
  const rollup = record(item.rollup);
  const plan = readPlan(item.plan);
  return {
    kind: item.kind,
    title: item.title,
    ...field('toolGroup',readToolReference(item.toolGroup)&&integer(record(item.toolGroup)?.count)&&Number(record(item.toolGroup)?.count)>0
      ?{...readToolReference(item.toolGroup)!,count:Number(record(item.toolGroup)!.count)}:undefined),
    ...field('toolOutput',readToolReference(item.toolOutput)&&typeof record(item.toolOutput)?.messageId==='string'
      ?{...readToolReference(item.toolOutput)!,messageId:String(record(item.toolOutput)!.messageId)}:undefined),
    ...field('text', typeof item.text === 'string' ? item.text : undefined),
    ...field('operation', typeof item.operation === 'string' ? item.operation : undefined),
    ...field('status', typeof item.status === 'string' ? item.status : undefined),
    ...field('command', typeof item.command === 'string' ? item.command : undefined),
    ...field('input', typeof item.input === 'string' ? item.input : undefined),
    ...field('output', typeof item.output === 'string' ? item.output : undefined),
    ...field('requestedBy', readActivityRequester(item.requestedBy)),
    ...field('thoughtMs', integer(item.thoughtMs) ? item.thoughtMs : undefined),
    ...field(
      'rollup',
      rollup && Object.values(rollup).every(integer)
        ? (rollup as Record<string, number>)
        : undefined,
    ),
    ...field(
      'observed',
      readList(item.observed, (candidate) => {
        const observed = record(candidate);
        if (!observed || typeof observed.verb !== 'string') return null;
        return {
          verb: observed.verb,
          ...field('target', typeof observed.target === 'string' ? observed.target : undefined),
          ...field('result', typeof observed.result === 'string' ? observed.result : undefined),
        };
      }),
    ),
    ...field(
      'files',
      readList(item.files, (candidate) => {
        const file = record(candidate);
        if (!file || typeof file.path !== 'string') return null;
        return {
          path: file.path,
          ...field('status', typeof file.status === 'string' ? file.status : undefined),
        };
      }),
    ),
    ...field('plan', plan),
  };
}


export function readPlan(value: unknown): RoomViewActivity['plan'] | undefined {
  const item = record(value);
  if (!item) return undefined;
  const items = readList(item.items, (candidate) => {
    const planItem = record(candidate);
    if (
      !planItem ||
      typeof planItem.step !== 'string' ||
      (planItem.status !== 'pending' &&
        planItem.status !== 'in_progress' &&
        planItem.status !== 'completed')
    ) {
      return null;
    }
    return {
      step: planItem.step,
      status: planItem.status as 'pending' | 'in_progress' | 'completed',
    };
  });
  if (!items) return undefined;
  return {
    items,
    ...field('objective', typeof item.objective === 'string' ? item.objective : undefined),
  };
}


export function readAgentGrantView(value: unknown): AgentGrantView | null {
  const item = record(value);
  const requestedBy = readIdentity(item?.requestedBy);
  if (
    !item ||
    !nonempty(item.grantId) ||
    !isAgentGrantKind(item.kind) ||
    typeof item.target !== 'string' ||
    typeof item.reason !== 'string' ||
    !isAgentGrantStatus(item.status) ||
    !requestedBy ||
    !uuid(item.roomId) ||
    !integer(item.createdAt) ||
    typeof item.auto !== 'boolean'
  ) {
    return null;
  }
  const decidedBy = readIdentity(item.decidedBy);
  return {
    grantId: item.grantId,
    kind: item.kind,
    target: item.target,
    ...field('appName', nonempty(item.appName) ? item.appName : undefined),
    ...field('purpose', nonempty(item.purpose) && item.purpose.length <= 240 ? item.purpose : undefined),
    ...field('touches', nonempty(item.touches) && item.touches.length <= 240 ? item.touches : undefined),
    ...field('capabilities', nonempty(item.capabilities) && item.capabilities.length <= 240 ? item.capabilities : undefined),
    ...field('machine', nonempty(item.machine) ? item.machine : undefined),
    reason: item.reason,
    status: item.status,
    requestedBy,
    roomId: item.roomId,
    createdAt: item.createdAt,
    auto: item.auto,
    ...field('decidedBy', decidedBy ?? undefined),
    ...field('decidedAt', integer(item.decidedAt) ? item.decidedAt : undefined),
    ...field('expiresAt', integer(item.expiresAt) ? item.expiresAt : undefined),
    ...field('script', isCommandGrantScript(item.script) ? item.script : undefined),
  };
}


export function readWorkspaceMemberGrantView(value: unknown): WorkspaceMemberGrantView | null {
  const item = record(value);
  const grant = readAgentGrantView(value);
  const agent = readIdentity(item?.agent);
  if (!grant || !agent || agent.kind !== 'agent') return null;
  return { ...grant, agent, ...field('roomName', typeof item?.roomName === 'string' ? item.roomName : undefined) };
}


export function readGrantRequest(value: unknown): GrantRequestCardView | null {
  const item = record(value);
  const agent = readIdentity(item?.agent);
  const owner = readIdentity(item?.owner);
  const requester = readIdentity(item?.requester);
  const grants = readList(item?.grants, readAgentGrantView);
  if (
    !item ||
    !agent ||
    agent.kind !== 'agent' ||
    !owner ||
    owner.kind !== 'human' ||
    !requester ||
    !grants ||
    grants.length === 0
  ) {
    return null;
  }
  return {
    agent,
    owner,
    requester,
    grants,
    ...(uuid(item.sourceRoomId) && hex64(item.sourceMessageId)
      ? { sourceRoomId: item.sourceRoomId, sourceMessageId: item.sourceMessageId }
      : {}),
  };
}


export function readAppSignInCard(value: unknown): NonNullable<RoomViewMessage['appSignIn']> | null {
  const item = record(value);
  if (!item || !uuid(item.appId) || typeof item.appKey !== 'string' ||
    !item.appKey || typeof item.name !== 'string' || !item.name ||
    !hex64(item.ownerId) || !hex64(item.agentId) ||
    (item.status !== 'pending' && item.status !== 'connected' && item.status !== 'failed')) return null;
  return { appId: item.appId, appKey: item.appKey, name: item.name,
    ownerId: item.ownerId, agentId: item.agentId, status: item.status,
    ...field('logo', httpUrl(item.logo) ? item.logo : undefined),
    ...field('domain', nonempty(item.domain) ? item.domain : undefined),
    ...field('errorMessage', typeof item.errorMessage === 'string' && item.errorMessage.length <= 500
      ? item.errorMessage : undefined),
    ...field('continuation', typeof item.continuation === 'string' && item.continuation.length <= 160
      ? item.continuation : undefined) };
}


export const AGENT_SIGN_IN_STATUSES = ['starting', 'pending', 'signing-in', 'signed-in', 'failed'] as const;

const AGENT_SIGN_IN_KINDS = ['paste-code', 'device-code', 'approve-wait', 'api-key'] as const;


export function readAgentSignInCard(value: unknown): NonNullable<RoomViewMessage['agentSignIn']> | null {
  const item = record(value);
  const status = oneOf(item?.status, AGENT_SIGN_IN_STATUSES);
  if (!item || !hex64(item.agentId) || !hex64(item.ownerId) || !status ||
    !isAgentSignInHarness(item.harness)) return null;
  return {
    agentId: item.agentId,
    ownerId: item.ownerId,
    harness: item.harness,
    status,
    ...field('kind', oneOf(item.kind, AGENT_SIGN_IN_KINDS)),
    ...field('authorizeUrl', httpUrl(item.authorizeUrl) && item.authorizeUrl.startsWith('https://')
      ? item.authorizeUrl : undefined),
    ...field('userCode', typeof item.userCode === 'string' && /^[A-Z0-9-]{4,16}$/.test(item.userCode)
      ? item.userCode : undefined),
    ...field('expiresAt', typeof item.expiresAt === 'number' && Number.isFinite(item.expiresAt)
      ? item.expiresAt : undefined),
    ...field('provider', isAgentSignInKeyProvider(item.provider) ? item.provider : undefined),
    ...field('errorMessage', typeof item.errorMessage === 'string' && item.errorMessage.length <= 500
      ? item.errorMessage : undefined),
  };
}


export function readHumanApprovalIdentity(value: unknown): RoomViewIdentity | undefined {
  const identity = readIdentity(value);
  return identity?.kind === 'human' ? identity : undefined;
}


export function readApprovalFact(value: unknown): { label: string; value: string } | null {
  const item = record(value);
  return item && nonempty(item.label) && nonempty(item.value)
    ? { label: item.label, value: item.value } : null;
}


export function readSquireApproval(value: unknown): NonNullable<RoomViewMessage['squireApproval']> | null {
  const item = record(value);
  const agent = readIdentity(item?.agent);
  const linkKind = oneOf(item?.linkKind, ['approval', 'passkey', 'vouch']);
  if (
    !item ||
    !agent ||
    agent.kind !== 'agent' ||
    !nonempty(item.tool) ||
    !nonempty(item.title) ||
    !nonempty(item.detail) ||
    !httpUrl(item.approvalUrl) ||
    !linkKind
  ) {
    return null;
  }
  return {
    agent,
    tool: item.tool,
    title: item.title,
    detail: item.detail,
    approvalUrl: item.approvalUrl,
    linkKind,
    ...field('owner', readHumanApprovalIdentity(item.owner)),
    ...field('status', oneOf(item.status, ['approved', 'denied', 'expired'])),
    ...field('decidedBy', readHumanApprovalIdentity(item.decidedBy)),
    ...field('decidedAt', integer(item.decidedAt) ? item.decidedAt : undefined),
    ...field('reason', nonempty(item.reason) ? item.reason : undefined),
    ...field('action', nonempty(item.action) ? item.action : undefined),
    ...field('reference', nonempty(item.reference) ? item.reference : undefined),
    ...field('facts', readList(item.facts, readApprovalFact)),
    ...field('approvalId', nonempty(item.approvalId) ? item.approvalId : undefined),
    ...(uuid(item.sourceRoomId) && hex64(item.sourceMessageId)
      ? { sourceRoomId: item.sourceRoomId, sourceMessageId: item.sourceMessageId }
      : {}),
  };
}


export function readComputerSession(value: unknown): NonNullable<RoomViewMessage['computerSession']> | null {
  const item = record(value);
  if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.id) ||
    !httpUrl(item.url) || !nonempty(item.title) ||
    (item.status !== 'live' && item.status !== 'ended')) return null;
  const url = new URL(item.url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== `/s/${item.id}/`)
    return null;
  return { id: item.id, url: item.url, title: item.title, status: item.status };
}


export function readConnectorOfferCardView(value: unknown): ConnectorOfferCardView | null {
  const item = record(value);
  const helper = record(item?.helper);
  const agent = readIdentity(item?.agent);
  const addressee = readIdentity(item?.addressee);
  if (
    !item ||
    !uuid(item.offerId) ||
    !agent ||
    agent.kind !== 'agent' ||
    !addressee ||
    addressee.kind !== 'human' ||
    !isConnectorKind(item.connectorType) ||
    !nonempty(item.connectorName) ||
    typeof item.reason !== 'string' ||
    !nonempty(item.consequence) ||
    !helper ||
    typeof helper.machineId !== 'string' ||
    typeof helper.name !== 'string' ||
    !isConnectorOfferStatus(item.status) ||
    !integer(item.createdAt)
  ) {
    return null;
  }
  return {
    offerId: item.offerId,
    agent,
    addressee,
    connectorType: item.connectorType,
    connectorName: item.connectorName,
    reason: item.reason,
    consequence: item.consequence,
    helper: { machineId: helper.machineId, name: helper.name },
    status: item.status,
    createdAt: item.createdAt,
    ...field('acceptedBy', readIdentityOnly(item.acceptedBy)),
    ...field('acceptedAt', integer(item.acceptedAt) ? item.acceptedAt : undefined),
    ...field('connectorId', typeof item.connectorId === 'string' ? item.connectorId : undefined),
    ...field('replacementMessageId', nonempty(item.replacementMessageId) ? item.replacementMessageId : undefined),
    ...field('intent', isConnectorOfferIntent(item.intent) ? item.intent : undefined),
    ...field('provider', typeof item.provider === 'string' ? item.provider : undefined),
  };
}


function isConnectorOfferCardView(value: unknown): value is ConnectorOfferCardView {
  return readConnectorOfferCardView(value) !== null;
}


export function choiceLetter(value: unknown): value is (typeof CHOICE_LETTERS)[number] {
  return typeof value === 'string' && (CHOICE_LETTERS as readonly string[]).includes(value);
}


export function readChoiceOption(value: unknown): ChoiceCardView['options'][number] | null {
  const item = record(value);
  if (!item || !choiceLetter(item.optionId) || item.letter !== item.optionId) return null;
  if (typeof item.label !== 'string' || typeof item.consequence !== 'string') return null;
  return {
    optionId: item.optionId,
    letter: item.optionId,
    label: item.label,
    consequence: item.consequence,
    ...field('costly', item.costly === true ? true : undefined),
    ...field('votes', integer(item.votes) ? item.votes : undefined),
    ...field(
      'share',
      typeof item.share === 'number' &&
        Number.isFinite(item.share) &&
        item.share >= 0 &&
        item.share <= 1
        ? item.share
        : undefined,
    ),
    ...field('leader', item.leader === true ? true : undefined),
  };
}


export function readChoiceVideoPreview(value: unknown): ChoiceCardView['videoPreview'] | undefined {
  const item = record(value);
  if (!item || !uuid(item.videoObjectId) || typeof item.frameUrl !== 'string' || !/^https?:\/\//.test(item.frameUrl) ||
    typeof item.title !== 'string' || item.title.length > 100 || typeof item.description !== 'string' || item.description.length > 5000 ||
    !oneOf(item.visibility, ['public', 'unlisted', 'private'])) return undefined;
  return { videoObjectId: item.videoObjectId, frameUrl: item.frameUrl, title: item.title, description: item.description,
    visibility: item.visibility as 'public' | 'unlisted' | 'private' };
}
