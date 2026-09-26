import { isSystemEvent } from './system-events.js';
import { isAgentAccessPolicy } from './agent-access.js';
import {
  MESSAGE_REACTION_EMOJIS,
  ROOM_VIEW_AGENT_LIMIT,
  ROOM_VIEW_BRIEFING_LIMIT,
  ROOM_VIEW_CHAT_LIMIT,
  ROOM_VIEW_MEMBER_LIMIT,
  ROOM_VIEW_MESSAGE_LIMIT,
  ROOM_VIEW_TOOL_ROW_LIMIT,
  ROOM_VIEW_WORKSPACE_LIMIT,
  WORKSPACE_MEMBER_PAGE_SIZE,
  type AgentAccessView,
  type AgentComposerCommand,
  type AgentDetailView,
  type AgentGrantView,
  type AgentModelConfigOption,
  type AgentModelSelection,
  type AgentPairingAbandonView,
  type AgentPairingClaimView,
  type AgentPairingClaimWireView,
  type AgentYoloView,
  type ChatListCorner,
  type ChatListItem,
  type ChatListView,
  type ChatListWorkspace,
  type ChoiceCardView,
  type CornerLifecycleView,
  type CornerListItem,
  type CornerListView,
  type GrantRequestCardView,
  type InviteView,
  type MessageReactionView,
  type RoomHistoryView,
  type RoomRepositoryResolution,
  type RoomRepositoryView,
  type RoomView,
  type RoomViewActivity,
  type RoomViewAgentTurn,
  type RoomViewHeader,
  type RoomViewIdentity,
  type RoomViewMember,
  type RoomViewMessage,
  type RoomViewer,
  type SurfaceWatchFilter,
  type WorkspaceAgentView,
  type WorkspaceListView,
  type WorkspaceManagedRoomView,
  type WorkspaceMemberGrantView,
  type WorkspaceMemberListView,
  type WorkspaceView,
} from './phone-types.js';
import { isAgentGrantKind, isAgentGrantStatus, isCommandGrantScript } from './agent-grants.js';
import { isConnectorOfferStatus, type ConnectorOfferCardView } from './connector-offers.js';
import { isConnectorKind } from './workbench.js';
import { CHOICE_LETTERS, isChoiceMode, isChoiceStatus } from './room-choices.js';
import {
  readCornerAppDefinition,
  readCornerAppManifest,
  type CornerAppBindingView,
  type CornerAppInstallationView,
  type CornerAppView,
} from './corner-apps.js';

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

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA1 = /^[0-9a-f]{40}$/i;
const WATCH_FILTER_LIMIT = 32;
const WATCH_FILTER_TAG_KEYS: readonly string[] = ['authors', '#h', '#d', '#p', '#t'];
const CLOSED_VIEWER: RoomViewer = {
  identity: { pubkey: '0'.repeat(64), kind: 'human', name: '' },
  role: 'member',
  permissions: { send: false, manage: false },
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hex64(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function githubUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

function field<K extends string, V>(
  key: K,
  value: V | undefined | null,
): { [P in K]?: Exclude<V, undefined> } {
  return value === undefined || value === null
    ? {}
    : ({ [key]: value } as { [P in K]: Exclude<V, undefined> });
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function readList<T>(value: unknown, read: SurfaceReader<T>, limit?: number): T[] | undefined {
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

function requireList<T>(value: unknown, read: SurfaceReader<T>, limit?: number): T[] | null {
  return Array.isArray(value) ? (readList(value, read, limit) ?? []) : null;
}

/**
 * The server emits message rows oldest-first and already trims its own tail, so
 * a bundle whose cap is lower than the server's must keep the NEWEST rows.
 */
function readNewestList<T>(value: unknown, read: SurfaceReader<T>, limit: number): T[] | undefined {
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

function readHeader(value: unknown): RoomViewHeader | null {
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

function readPresence(value: unknown): RoomViewMember['presence'] | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (item.status !== 'online' && item.status !== 'offline') return undefined;
  if (!integer(item.observedAt)) return undefined;
  return {
    status: item.status,
    observedAt: item.observedAt,
    ...field('roomId', uuid(item.roomId) ? item.roomId : undefined),
  };
}

function readMember(value: unknown): RoomViewMember | null {
  const item = record(value);
  const identity = readIdentity(item?.identity);
  if (!item || !identity) return null;
  const role = typeof item.role === 'string' && item.role.length > 0 ? item.role : 'member';
  return {
    identity,
    role: role as RoomViewMember['role'],
    ...field('presence', readPresence(item.presence)),
  };
}

function readWorkspaceAgent(value: unknown): WorkspaceAgentView | null {
  const member = readMember(value);
  const item = record(value);
  if (!member || !item || member.identity.kind !== 'agent') return null;
  const owner = readIdentity(item.owner);
  return {
    ...member,
    ...field('model', typeof item.model === 'string' ? item.model : undefined),
    ...field('owner', owner && owner.kind === 'human' ? owner : undefined),
  };
}

function readPermissions(value: unknown): RoomViewer['permissions'] | undefined {
  const item = record(value);
  if (!item || typeof item.send !== 'boolean' || typeof item.manage !== 'boolean') return undefined;
  return { send: item.send, manage: item.manage };
}

function readViewer(value: unknown): RoomViewer {
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
          ...field(
            'unreadAgentTurnCount',
            integer(cursor.unreadAgentTurnCount) && cursor.unreadAgentTurnCount >= 0
              ? cursor.unreadAgentTurnCount
              : undefined,
          ),
        }
      : undefined;
  return {
    identity,
    role: role as RoomViewer['role'],
    permissions,
    ...field('readCursor', readCursor),
  };
}

function readIdentityOnly(value: unknown): RoomViewIdentity | undefined {
  return readIdentity(value) ?? undefined;
}

function readWatchFilter(value: unknown): SurfaceWatchFilter | null {
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

function readWatchFilters(value: unknown): SurfaceWatchFilter[] {
  return readList(value, readWatchFilter, WATCH_FILTER_LIMIT) ?? [];
}

function readAttachment(
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

function readActivityRequester(
  value: unknown,
): NonNullable<RoomViewActivity['requestedBy']> | undefined {
  const item = record(value);
  if (!item || !hex64(item.pubkey)) return undefined;
  return {
    pubkey: item.pubkey,
    ...field('name', typeof item.name === 'string' ? item.name : undefined),
  };
}

function readActivity(value: unknown): RoomViewActivity | null {
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

function readPlan(value: unknown): RoomViewActivity['plan'] | undefined {
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

export function isAgentGrantView(value: unknown): value is AgentGrantView {
  return readAgentGrantView(value) !== null;
}

function readWorkspaceMemberGrantView(value: unknown): WorkspaceMemberGrantView | null {
  const item = record(value);
  const grant = readAgentGrantView(value);
  const agent = readIdentity(item?.agent);
  if (!grant || !agent || agent.kind !== 'agent') return null;
  return { ...grant, agent };
}

function readGrantRequest(value: unknown): GrantRequestCardView | null {
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

function readSquireApproval(value: unknown): NonNullable<RoomViewMessage['squireApproval']> | null {
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
    ...field('approvalId', nonempty(item.approvalId) ? item.approvalId : undefined),
    ...(uuid(item.sourceRoomId) && hex64(item.sourceMessageId)
      ? { sourceRoomId: item.sourceRoomId, sourceMessageId: item.sourceMessageId }
      : {}),
  };
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
  };
}

export function isConnectorOfferCardView(value: unknown): value is ConnectorOfferCardView {
  return readConnectorOfferCardView(value) !== null;
}

function choiceLetter(value: unknown): value is (typeof CHOICE_LETTERS)[number] {
  return typeof value === 'string' && (CHOICE_LETTERS as readonly string[]).includes(value);
}

function readChoiceOption(value: unknown): ChoiceCardView['options'][number] | null {
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

function readChoiceCard(value: unknown): ChoiceCardView | null {
  const item = record(value);
  const agent = readIdentity(item?.agent);
  const options = readList(item?.options, readChoiceOption);
  if (
    !item ||
    !uuid(item.choiceId) ||
    !isChoiceMode(item.mode) ||
    !isChoiceStatus(item.status) ||
    !agent ||
    (agent.kind !== 'agent' && !(item.mode === 'poll' && agent.kind === 'human')) ||
    typeof item.prompt !== 'string' ||
    !options ||
    options.length < 2 ||
    options.length > 4 ||
    !Array.isArray(item.electorate) ||
    !item.electorate.every(hex64) ||
    !integer(item.votedCount) ||
    !integer(item.electorateCount)
  ) {
    return null;
  }
  const responses = readList(item.responses, (candidate) => {
    const response = record(candidate);
    if (!response || !hex64(response.identityId) || !choiceLetter(response.optionId)) return null;
    return { identityId: response.identityId, optionId: response.optionId };
  });
  return {
    choiceId: item.choiceId,
    mode: item.mode,
    status: item.status,
    agent,
    prompt: item.prompt,
    options,
    electorate: item.electorate,
    votedCount: item.votedCount,
    electorateCount: item.electorateCount,
    responses: responses ?? [],
    ...field('requester', readIdentityOnly(item.requester)),
    ...field('constraint', typeof item.constraint === 'string' ? item.constraint : undefined),
    ...field(
      'mentionIds',
      Array.isArray(item.mentionIds) && item.mentionIds.every(hex64) ? item.mentionIds : undefined,
    ),
    ...field('closesAt', integer(item.closesAt) ? item.closesAt : undefined),
    ...field('answeredBy', readIdentityOnly(item.answeredBy)),
    ...field(
      'selectedOptionId',
      choiceLetter(item.selectedOptionId) ? item.selectedOptionId : undefined,
    ),
    ...field('outcome', oneOf(item.outcome, ['winner', 'tie', 'no-votes'])),
    ...field('footer', typeof item.footer === 'string' ? item.footer : undefined),
  };
}

function readWalletTx(value: unknown): NonNullable<RoomViewMessage['walletTx']> | null {
  const item = record(value);
  if (
    !item ||
    (item.direction !== 'in' && item.direction !== 'out') ||
    typeof item.amountText !== 'string' ||
    typeof item.counterparty !== 'string' ||
    typeof item.chain !== 'string' ||
    typeof item.balanceAfterUsd !== 'string'
  ) {
    return null;
  }
  return {
    direction: item.direction,
    amountText: item.amountText,
    counterparty: item.counterparty,
    chain: item.chain,
    balanceAfterUsd: item.balanceAfterUsd,
    ...field('txUrl', typeof item.txUrl === 'string' ? item.txUrl : undefined),
    ...field(
      'agentName',
      typeof item.agentName === 'string' || item.agentName === null ? item.agentName : undefined,
    ),
  };
}

function readWalletInsufficient(
  value: unknown,
): NonNullable<RoomViewMessage['walletInsufficient']> | null {
  const item = record(value);
  if (
    !item ||
    typeof item.needed !== 'string' ||
    typeof item.asset !== 'string' ||
    typeof item.chain !== 'string'
  ) {
    return null;
  }
  return {
    needed: item.needed,
    asset: item.asset,
    chain: item.chain,
    ...field(
      'available',
      typeof item.available === 'string' || item.available === null ? item.available : undefined,
    ),
    ...field(
      'agentName',
      typeof item.agentName === 'string' || item.agentName === null ? item.agentName : undefined,
    ),
    ...field('reason', typeof item.reason === 'string' ? item.reason : undefined),
  };
}

function readWalletDelegation(
  value: unknown,
): NonNullable<RoomViewMessage['walletDelegation']> | null {
  const item = record(value);
  if (!item || !integer(item.expiresAt) || !integer(item.ttlHours)) return null;
  return { expiresAt: item.expiresAt, ttlHours: item.ttlHours };
}

function readMessageCorner(value: unknown): NonNullable<RoomViewMessage['corner']> | null {
  const item = record(value);
  if (
    !item ||
    !uuid(item.id) ||
    (item.state !== 'working' &&
      item.state !== 'waiting' &&
      item.state !== 'review' &&
      item.state !== 'archived')
  ) {
    return null;
  }
  return { id: item.id, state: item.state };
}

function readMessageCornerApp(value: unknown): NonNullable<RoomViewMessage['cornerApp']> | null {
  const item = record(value);
  return item &&
    typeof item.slug === 'string' &&
    typeof item.title === 'string' &&
    integer(item.revision)
    ? { slug: item.slug, title: item.title, revision: item.revision }
    : null;
}

function readCornerApp(value: unknown): CornerAppView | null {
  const item = record(value);
  const definition = readCornerAppDefinition(item);
  if (
    !item ||
    !definition ||
    (item.authorId !== undefined && !hex64(item.authorId)) ||
    typeof item.authorName !== 'string' ||
    !integer(item.revision) ||
    !integer(item.updatedAt)
  )
    return null;
  return {
    ...definition,
    ...(typeof item.authorId === 'string' ? { authorId: item.authorId } : {}),
    authorName: item.authorName,
    ...(typeof item.authorHandle === 'string' ? { authorHandle: item.authorHandle } : {}),
    revision: item.revision,
    updatedAt: item.updatedAt,
  };
}

function readCornerAppInstallation(value: unknown): CornerAppInstallationView | null {
  const item = record(value);
  const manifest = readCornerAppManifest(item?.manifest);
  return item && uuid(item.id) && manifest ? { id: item.id, manifest } : null;
}

function readCornerAppBinding(value: unknown): CornerAppBindingView | null {
  const installation = readCornerAppInstallation(value);
  const item = record(value);
  return installation && item && uuid(item.instanceId)
    ? { ...installation, instanceId: item.instanceId }
    : null;
}

function readPermission(value: unknown): NonNullable<RoomViewMessage['permission']> | null {
  const item = record(value);
  const agent = readIdentity(item?.agent);
  const requester = readIdentity(item?.requester);
  const decider = readIdentity(item?.decider);
  if (
    !item ||
    !nonempty(item.permissionId) ||
    !nonempty(item.requestId) ||
    !agent ||
    agent.kind !== 'agent' ||
    !requester ||
    requester.kind !== 'human' ||
    !nonempty(item.tool) ||
    (item.status !== 'pending' &&
      item.status !== 'allowed' &&
      item.status !== 'denied' &&
      item.status !== 'expired' &&
      item.status !== 'failed')
  ) {
    return null;
  }
  return {
    permissionId: item.permissionId,
    requestId: item.requestId,
    agent,
    requester,
    tool: item.tool,
    status: item.status,
    ...field('decider', decider && decider.kind === 'human' ? decider : undefined),
    ...field('repository', typeof item.repository === 'string' ? item.repository : undefined),
    ...field('purpose', oneOf(item.purpose, ['squire-spending'])),
    ...field('cornerId', uuid(item.cornerId) ? item.cornerId : undefined),
  };
}

function readTargetBranch(value: unknown): NonNullable<RoomViewMessage['targetBranch']> | null {
  const item = record(value);
  if (!item || !nonempty(item.proposalId) || typeof item.from !== 'string' || !nonempty(item.to)) {
    return null;
  }
  return {
    proposalId: item.proposalId,
    from: item.from,
    to: item.to,
    ...field('repository', typeof item.repository === 'string' ? item.repository : undefined),
    ...field('agent', readIdentityOnly(item.agent)),
    ...field('requester', readIdentityOnly(item.requester)),
  };
}

function readGithubEvent(value: unknown): NonNullable<RoomViewMessage['githubEvent']> | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.type) ||
    !nonempty(item.action) ||
    typeof item.actor !== 'string' ||
    typeof item.title !== 'string' ||
    !githubUrl(item.url)
  ) {
    return null;
  }
  return {
    type: item.type,
    action: item.action,
    actor: item.actor,
    title: item.title,
    url: item.url,
    ...field('branch', typeof item.branch === 'string' ? item.branch : undefined),
    ...field('targetBranch', typeof item.targetBranch === 'string' ? item.targetBranch : undefined),
  };
}

function readDaemonFact(value: unknown): NonNullable<RoomViewMessage['daemonFact']> | null {
  const item = record(value);
  if (
    !item ||
    (item.type !== 'corner-complete' &&
      item.type !== 'checks-failing' &&
      item.type !== 'worktree-cleaned' &&
      item.type !== 'corner-open') ||
    !uuid(item.cornerId) ||
    typeof item.objective !== 'string' ||
    // The objective titles a legacy card; a person-opened corner has none and
    // is titled by its name instead. A card must carry one of the two.
    (!item.objective.trim() && !(typeof item.name === 'string' && item.name.trim()))
  ) {
    return null;
  }
  if (
    item.type === 'corner-complete' &&
    item.outcome !== 'landed' &&
    item.outcome !== 'abandoned'
  ) {
    return null;
  }
  const pullRequest = record(item.pullRequest);
  const projectedPull =
    pullRequest && githubUrl(pullRequest.url)
      ? {
          url: pullRequest.url,
          ...field(
            'number',
            Number.isSafeInteger(pullRequest.number) && Number(pullRequest.number) > 0
              ? (pullRequest.number as number)
              : undefined,
          ),
          ...field('title', typeof pullRequest.title === 'string' ? pullRequest.title : undefined),
          ...field(
            'targetBranch',
            typeof pullRequest.targetBranch === 'string' ? pullRequest.targetBranch : undefined,
          ),
        }
      : undefined;
  return {
    type: item.type,
    cornerId: item.cornerId,
    objective: item.objective,
    ...field('name', typeof item.name === 'string' ? item.name : undefined),
    ...field(
      'sourceMessageId',
      typeof item.sourceMessageId === 'string' && item.sourceMessageId
        ? item.sourceMessageId
        : undefined,
    ),
    ...field('outcome', oneOf(item.outcome, ['landed', 'abandoned'])),
    ...field('pullRequest', projectedPull),
    ...field(
      'subgoals',
      readList(item.subgoals, (candidate) => {
        const entry = record(candidate);
        if (
          !entry ||
          typeof entry.step !== 'string' ||
          !entry.step.trim() ||
          (entry.status !== 'pending' &&
            entry.status !== 'in_progress' &&
            entry.status !== 'completed')
        ) {
          return null;
        }
        return { step: entry.step, status: entry.status };
      }),
    ),
  };
}

function readReaction(value: unknown): MessageReactionView | null {
  const item = record(value);
  if (
    !item ||
    !(MESSAGE_REACTION_EMOJIS as readonly string[]).includes(item.emoji as string) ||
    !integer(item.count) ||
    item.count <= 0 ||
    typeof item.reacted !== 'boolean'
  ) {
    return null;
  }
  const members = readList(item.members, readIdentity);
  return {
    emoji: item.emoji as MessageReactionView['emoji'],
    count: item.count,
    reacted: item.reacted,
    ...field('members', members),
  };
}

function readRelay(value: unknown): NonNullable<RoomViewMessage['relay']> | null {
  const item = record(value);
  if (
    !item ||
    typeof item.fromRoomId !== 'string' ||
    typeof item.toRoomId !== 'string' ||
    (item.direction !== 'down' && item.direction !== 'up') ||
    typeof item.fromName !== 'string' ||
    typeof item.cornerId !== 'string' ||
    typeof item.received !== 'boolean'
  ) {
    return null;
  }
  return {
    fromRoomId: item.fromRoomId,
    toRoomId: item.toRoomId,
    direction: item.direction,
    fromName: item.fromName,
    cornerId: item.cornerId,
    received: item.received,
    ...field(
      'anchorMessageId',
      typeof item.anchorMessageId === 'string' ? item.anchorMessageId : undefined,
    ),
  };
}

export function readRoomViewMessage(value: unknown): RoomViewMessage | null {
  const item = record(value);
  const author = readIdentity(item?.author);
  if (!item || !hex64(item.id) || !author || !integer(item.createdAt)) return null;
  const presentation =
    item.presentation === 'message' ||
    item.presentation === 'system' ||
    item.presentation === 'activity' ||
    item.presentation === 'card'
      ? item.presentation
      : 'message';
  const reference = record(item.reference);
  const reply = record(item.reply);
  const projectedReference =
    reference &&
    uuid(reference.channelId) &&
    reference.eventId === item.id &&
    hex64(reference.rootId)
      ? {
          channelId: reference.channelId,
          eventId: item.id,
          rootId: reference.rootId,
        }
      : undefined;
  const projectedReply =
    reply && uuid(reply.channelId) && hex64(reply.eventId) && hex64(reply.rootId)
      ? { channelId: reply.channelId, eventId: reply.eventId, rootId: reply.rootId }
      : undefined;
  return {
    id: item.id,
    text: typeof item.text === 'string' ? item.text : '',
    createdAt: item.createdAt,
    author,
    presentation,
    ...field('deleted', typeof item.deleted === 'boolean' ? item.deleted : undefined),
    ...field('createdAtMs', integer(item.createdAtMs) ? item.createdAtMs : undefined),
    ...field('bookmarked', typeof item.bookmarked === 'boolean' ? item.bookmarked : undefined),
    ...field('reference', projectedReference),
    ...field('reply', projectedReply),
    ...field('liveTurnId', typeof item.liveTurnId === 'string' ? item.liveTurnId : undefined),
    ...field('requestId', typeof item.requestId === 'string' ? item.requestId : undefined),
    ...field('agentModel', typeof item.agentModel === 'string' ? item.agentModel : undefined),
    ...field('attachments', readList(item.attachments, readAttachment)),
    ...field(
      'mentionPubkeys',
      Array.isArray(item.mentionPubkeys) && item.mentionPubkeys.every(hex64)
        ? item.mentionPubkeys
        : undefined,
    ),
    ...field('reactions', readList(item.reactions, readReaction)),
    ...field('activity', readList(item.activity, readActivity)),
    ...field('durableFact', oneOf(item.durableFact, ['failure', 'merge', 'action'])),
    ...field('corner', readMessageCorner(item.corner)),
    ...field('cornerApp', readMessageCornerApp(item.cornerApp)),
    ...field('permission', readPermission(item.permission)),
    ...field('grantRequest', readGrantRequest(item.grantRequest)),
    ...field('squireApproval', readSquireApproval(item.squireApproval)),
    ...field('connectorOffer', readConnectorOfferCardView(item.connectorOffer)),
    ...field('choice', readChoiceCard(item.choice)),
    ...field('walletTx', readWalletTx(item.walletTx)),
    ...field('walletInsufficient', readWalletInsufficient(item.walletInsufficient)),
    ...field('walletDelegation', readWalletDelegation(item.walletDelegation)),
    ...field('targetBranch', readTargetBranch(item.targetBranch)),
    ...field('githubEvent', readGithubEvent(item.githubEvent)),
    ...field('relay', readRelay(item.relay)),
    ...field('daemonFact', readDaemonFact(item.daemonFact)),
    ...field('systemEvent', isSystemEvent(item.systemEvent) ? item.systemEvent : undefined),
  };
}

export function isRoomViewMessage(value: unknown): value is RoomViewMessage {
  return readRoomViewMessage(value) !== null;
}

function readScopedMessage(value: unknown, roomId: string): RoomViewMessage | null {
  const message = readRoomViewMessage(value);
  if (!message) return null;
  const reference =
    message.reference && message.reference.channelId === roomId ? message.reference : undefined;
  const reply = message.reply && message.reply.channelId === roomId ? message.reply : undefined;
  const { reference: _foreignReference, reply: _foreignReply, ...rest } = message;
  return { ...rest, ...field('reference', reference), ...field('reply', reply) };
}

function readAgentTurn(value: unknown): RoomViewAgentTurn | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.requestId) ||
    !hex64(item.agentPubkey) ||
    (item.status !== 'working' &&
      item.status !== 'complete' &&
      item.status !== 'failed' &&
      item.status !== 'cancelled') ||
    !integer(item.createdAt)
  ) {
    return null;
  }
  return {
    requestId: item.requestId,
    agentPubkey: item.agentPubkey,
    status: item.status,
    createdAt: item.createdAt,
    ...field('startedAt', integer(item.startedAt) ? item.startedAt : undefined),
    ...field('generationId', typeof item.generationId === 'string' ? item.generationId : undefined),
    ...field('requestedBy', typeof item.requestedBy === 'string' ? item.requestedBy : undefined),
  };
}

function readWorkspace(value: unknown): ChatListWorkspace | null {
  const item = record(value);
  if (!item || !uuid(item.id)) return null;
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    role: oneOf(item.role, ['owner', 'admin', 'member', 'spectator']) ?? 'member',
    updatedAt: integer(item.updatedAt) ? item.updatedAt : 0,
    ...field('visibility', oneOf(item.visibility, ['public', 'invite-only'])),
    ...field('avatar', typeof item.avatar === 'string' ? item.avatar : undefined),
  };
}

function readLatest(value: unknown): NonNullable<ChatListItem['latestMessage']> | null {
  const item = record(value);
  const author = readIdentity(item?.author);
  if (
    !item ||
    !hex64(item.id) ||
    typeof item.text !== 'string' ||
    !integer(item.createdAt) ||
    !author
  ) {
    return null;
  }
  return {
    id: item.id,
    text: item.text,
    createdAt: item.createdAt,
    author,
    ...field('attachments', readList(item.attachments, readAttachment)),
    ...field('mentionsViewer', item.mentionsViewer === true ? (true as const) : undefined),
  };
}

function readChatCorner(value: unknown): ChatListCorner | null {
  const item = record(value);
  const state = oneOf(item?.state, ['working', 'waiting', 'review']);
  if (!item || !uuid(item.id) || typeof item.name !== 'string' || !state) return null;
  return {
    id: item.id,
    name: item.name,
    state,
    ...field('mine', item.mine === true ? (true as const) : undefined),
  };
}

function readChat(value: unknown): ChatListItem | null {
  const item = record(value);
  const room = readHeader(item?.room);
  if (!item || !room) return null;
  const direct = record(item.directMessage);
  const peer = readIdentity(direct?.peer);
  const presence = record(direct?.presence);
  const presenceStatus = oneOf(presence?.status, ['online', 'offline']);
  const projectedPresence =
    presence && presenceStatus && integer(presence.observedAt)
      ? { status: presenceStatus, observedAt: presence.observedAt }
      : undefined;
  const attentionReason = record(item.attentionReason);
  const projectedAttentionReason =
    attentionReason?.kind === 'approval'
      ? {
          kind: 'approval' as const,
          ...field(
            'actor',
            typeof attentionReason.actor === 'string' && attentionReason.actor.trim()
              ? attentionReason.actor
              : undefined,
          ),
        }
      : undefined;
  return {
    room,
    unread: item.unread === true,
    ...field('memberCount', integer(item.memberCount) ? item.memberCount : undefined),
    ...field('cornerCount', integer(item.cornerCount) ? item.cornerCount : undefined),
    ...field(
      'waitingCornerCount',
      integer(item.waitingCornerCount) && item.waitingCornerCount >= 0
        ? item.waitingCornerCount
        : undefined,
    ),
    ...field('openCorners', readList(item.openCorners, readChatCorner)),
    ...field(
      'agentsOffline',
      typeof item.agentsOffline === 'boolean' ? item.agentsOffline : undefined,
    ),
    ...field('closed', typeof item.closed === 'boolean' ? item.closed : undefined),
    ...field('latestMessage', readLatest(item.latestMessage)),
    ...field(
      'repositoryName',
      typeof item.repositoryName === 'string' ? item.repositoryName : undefined,
    ),
    ...field('agentState', oneOf(item.agentState, ['needs-you', 'working'])),
    ...field('attentionReason', projectedAttentionReason),
    ...field('directMessage', peer ? { peer, ...field('presence', projectedPresence) } : undefined),
  };
}

function readCheck(
  value: unknown,
): NonNullable<NonNullable<CornerLifecycleView['checksSummary']>['checks']>[number] | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.name) ||
    (item.status !== 'pending' && item.status !== 'passed' && item.status !== 'failed')
  ) {
    return null;
  }
  return {
    name: item.name,
    status: item.status,
    ...field('conclusion', typeof item.conclusion === 'string' ? item.conclusion : undefined),
    ...field('url', httpUrl(item.url) ? item.url : undefined),
  };
}

function readCornerLifecycle(value: unknown): CornerLifecycleView | null {
  const item = record(value);
  if (!item) return null;
  const checksSummary = record(item.checksSummary);
  const summaryStatus = oneOf(checksSummary?.status, ['passing', 'failing', 'pending', 'unknown']);
  const projectedSummary =
    checksSummary &&
    summaryStatus &&
    integer(checksSummary.total) &&
    integer(checksSummary.updatedAt)
      ? {
          status: summaryStatus,
          total: checksSummary.total,
          failing: Array.isArray(checksSummary.failing)
            ? checksSummary.failing.filter((entry): entry is string => typeof entry === 'string')
            : [],
          updatedAt: checksSummary.updatedAt,
          checks: readList(checksSummary.checks, readCheck, 200) ?? [],
        }
      : undefined;
  const pr = record(item.pr);
  const projectedPr =
    pr &&
    integer(pr.number) &&
    pr.number > 0 &&
    githubUrl(pr.url) &&
    nonempty(pr.title) &&
    nonempty(pr.targetBranch) &&
    typeof pr.headSha === 'string' &&
    SHA1.test(pr.headSha)
      ? {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          targetBranch: pr.targetBranch,
          headSha: pr.headSha,
          ...field('mergeability', oneOf(pr.mergeability, ['clean', 'dirty', 'unknown', 'other'])),
          ...field('baseSha', typeof pr.baseSha === 'string' ? pr.baseSha : undefined),
          ...field('mergedAt', typeof pr.mergedAt === 'string' ? pr.mergedAt : undefined),
          ...field('mergedBy', typeof pr.mergedBy === 'string' ? pr.mergedBy : undefined),
        }
      : undefined;
  return {
    lifecycle: oneOf(item.lifecycle, ['working', 'in-review', 'unknown', 'done']) ?? 'unknown',
    checks: oneOf(item.checks, ['passing', 'failing', 'pending', 'unknown']) ?? 'unknown',
    ...field('branch', typeof item.branch === 'string' ? item.branch : undefined),
    ...field('outcome', oneOf(item.outcome, ['landed', 'abandoned'])),
    ...field('reason', typeof item.reason === 'string' ? item.reason : undefined),
    ...field('checksSummary', projectedSummary),
    ...field('pr', projectedPr),
  };
}

function readCorner(value: unknown): CornerListItem | null {
  const item = record(value);
  const corner = readHeader(item?.corner);
  const lifecycle = readCornerLifecycle(item?.lifecycle) ?? {
    lifecycle: 'unknown' as const,
    checks: 'unknown' as const,
  };
  if (
    !item ||
    !corner ||
    (item.state !== 'working' &&
      item.state !== 'waiting' &&
      item.state !== 'review' &&
      item.state !== 'archived')
  ) {
    return null;
  }
  const initiator = readIdentity(item.initiator);
  return {
    corner,
    lifecycle,
    state: item.state,
    ...field('stateAt', integer(item.stateAt) ? item.stateAt : undefined),
    ...field('closedAt', integer(item.closedAt) ? item.closedAt : undefined),
    ...field('reason', oneOf(item.reason, ['failed', 'checks-failed', 'question'])),
    ...field('initiator', initiator && initiator.kind === 'human' ? initiator : undefined),
    ...field('awaitsViewer', item.awaitsViewer === true ? (true as const) : undefined),
    ...field('agent', readIdentityOnly(item.agent)),
    ...field('app', readCornerAppBinding(item.app)),
    ...field('latestMessage', readLatest(item.latestMessage)),
  };
}

function readRepository(value: unknown): RoomRepositoryView | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.key) ||
    !nonempty(item.name) ||
    !nonempty(item.remote) ||
    !nonempty(item.targetBranch) ||
    !integer(item.updatedAt) ||
    typeof item.githubEventsEnabled !== 'boolean'
  ) {
    return null;
  }
  return {
    key: item.key,
    name: item.name,
    remote: item.remote,
    targetBranch: item.targetBranch,
    updatedAt: item.updatedAt,
    githubEventsEnabled: item.githubEventsEnabled,
    ...field(
      'githubInstallationId',
      integer(item.githubInstallationId) ? item.githubInstallationId : undefined,
    ),
  };
}

function readRepositoryResolution(value: unknown): RoomRepositoryResolution | undefined {
  return value === 'repository' || value === 'none' || value === 'unverified' ? value : undefined;
}

function readDirectMessage(
  value: unknown,
  viewerPubkey: string,
): { readonly participants: readonly [string, string] } | undefined {
  const item = record(value);
  if (!item || !Array.isArray(item.participants) || item.participants.length !== 2)
    return undefined;
  const left = item.participants[0];
  const right = item.participants[1];
  if (!hex64(left) || !hex64(right)) return undefined;
  if (left >= right || (left !== viewerPubkey && right !== viewerPubkey)) return undefined;
  return { participants: [left, right] };
}

function readModelSelection(value: unknown): AgentModelSelection | undefined {
  const item = record(value);
  if (!item) return undefined;
  return {
    ...field('model', typeof item.model === 'string' ? item.model : undefined),
    ...field('effort', typeof item.effort === 'string' ? item.effort : undefined),
  };
}

function readModelOption(value: unknown): AgentModelConfigOption | null {
  const item = record(value);
  if (!item || !nonempty(item.id) || !nonempty(item.category)) return null;
  const options = readList(item.options, (candidate) => {
    const option = record(candidate);
    if (!option || !nonempty(option.id)) return null;
    return {
      id: option.id,
      ...field('name', typeof option.name === 'string' ? option.name : undefined),
    };
  });
  if (!options) return null;
  return {
    id: item.id,
    category: item.category,
    options,
    ...field('currentValue', typeof item.currentValue === 'string' ? item.currentValue : undefined),
  };
}

function readComposerCommand(value: unknown): AgentComposerCommand | null {
  const item = record(value);
  if (!item || !nonempty(item.name)) return null;
  return {
    name: item.name,
    ...field('description', nonempty(item.description) ? item.description : undefined),
    ...field('inputHint', nonempty(item.inputHint) ? item.inputHint : undefined),
  };
}

function readAgentYolo(value: unknown): AgentYoloView | null {
  const item = record(value);
  const setBy = record(item?.setBy);
  if (!item || typeof item.enabled !== 'boolean' || typeof item.canChange !== 'boolean')
    return null;
  return {
    enabled: item.enabled,
    canChange: item.canChange,
    ...field('forcedOff', typeof item.forcedOff === 'boolean' ? item.forcedOff : undefined),
    ...field('setBy', setBy && typeof setBy.name === 'string' ? { name: setBy.name } : undefined),
    ...field('setAt', integer(item.setAt) ? item.setAt : undefined),
  };
}

function readAgentAccess(value: unknown): AgentAccessView | null {
  const item = record(value);
  const owner = record(item?.owner);
  if (!item || !isAgentAccessPolicy(item.policy) || typeof item.canChange !== 'boolean')
    return null;
  return {
    policy: item.policy,
    canChange: item.canChange,
    ...field(
      'owner',
      owner && typeof owner.id === 'string' && typeof owner.name === 'string'
        ? {
            id: owner.id,
            name: owner.name,
            ...field('handle', typeof owner.handle === 'string' ? owner.handle : undefined),
          }
        : undefined,
    ),
  };
}

function readManagedRoom(value: unknown): WorkspaceManagedRoomView | null {
  const item = record(value);
  if (
    !item ||
    !uuid(item.id) ||
    typeof item.name !== 'string' ||
    (item.visibility !== 'public' && item.visibility !== 'invite-only') ||
    !integer(item.createdAt)
  ) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    visibility: item.visibility,
    createdAt: item.createdAt,
  };
}

export function readRoomView(value: unknown): RoomView | null {
  const item = record(value);
  const room = readHeader(item?.room);
  if (!item || !room) return null;
  const messages = readNewestList(
    item.messages,
    (candidate) => readScopedMessage(candidate, room.id),
    ROOM_VIEW_MESSAGE_LIMIT,
  );
  if (!messages) return null;
  const viewer = readViewer(item.viewer);
  return {
    room,
    messages,
    members: readList(item.members, readMember, ROOM_VIEW_MEMBER_LIMIT) ?? [],
    latestAgentTurns: readList(item.latestAgentTurns, readAgentTurn, ROOM_VIEW_AGENT_LIMIT) ?? [],
    viewer,
    repositoryResolution: readRepositoryResolution(item.repositoryResolution) ?? 'unverified',
    watchFilters: readWatchFilters(item.watchFilters),
    ...field(
      'toolRows',
      readNewestList(
        item.toolRows,
        (candidate) => readScopedMessage(candidate, room.id),
        ROOM_VIEW_TOOL_ROW_LIMIT,
      ),
    ),
    ...field('directMessage', readDirectMessage(item.directMessage, viewer.identity.pubkey)),
    ...field('parent', readHeader(item.parent)),
    ...field('briefing', readList(item.briefing, readRoomViewMessage, ROOM_VIEW_BRIEFING_LIMIT)),
    ...field('cornerPlan', readPlan(item.cornerPlan)),
    ...field('repository', readRepository(item.repository)),
    ...field('cornerLifecycle', readCornerLifecycle(item.cornerLifecycle)),
    ...field('cornerApps', readList(item.cornerApps, readCornerApp, 24)),
    ...field('boundApp', readCornerAppBinding(item.boundApp)),
  };
}

export function isRoomView(value: unknown): value is RoomView {
  return readRoomView(value) !== null;
}

export function readRoomHistoryView(value: unknown): RoomHistoryView | null {
  const item = record(value);
  if (!item || !uuid(item.roomId)) return null;
  const messages = readNewestList(
    item.messages,
    (candidate) => readScopedMessage(candidate, item.roomId as string),
    ROOM_VIEW_MESSAGE_LIMIT,
  );
  if (!messages) return null;
  const before = record(item.nextBefore);
  const nextBefore =
    before && integer(before.createdAt) && hex64(before.id)
      ? { createdAt: before.createdAt, id: before.id }
      : undefined;
  return { roomId: item.roomId, messages, ...field('nextBefore', nextBefore) };
}

export function isRoomHistoryView(value: unknown): value is RoomHistoryView {
  return readRoomHistoryView(value) !== null;
}

export function readWorkspaceListView(value: unknown): WorkspaceListView | null {
  const item = record(value);
  const viewer = readIdentity(item?.viewer);
  const workspaces = requireList(item?.workspaces, readWorkspace, ROOM_VIEW_WORKSPACE_LIMIT);
  if (!item || !viewer || !workspaces) return null;
  return {
    workspaces,
    viewer,
    truncated: typeof item.truncated === 'boolean' ? item.truncated : false,
    watchFilters: readWatchFilters(item.watchFilters),
    ...field(
      'deletedNotices',
      readList(item.deletedNotices, (candidate) => {
        const notice = record(candidate);
        if (!notice || !uuid(notice.workspaceId) || typeof notice.workspaceName !== 'string') {
          return null;
        }
        return { workspaceId: notice.workspaceId, workspaceName: notice.workspaceName };
      }),
    ),
  };
}

export function isWorkspaceListView(value: unknown): value is WorkspaceListView {
  return readWorkspaceListView(value) !== null;
}

export function readWorkspaceView(value: unknown): WorkspaceView | null {
  const item = record(value);
  const workspace = readWorkspace(item?.workspace);
  const rawWorkspace = record(item?.workspace);
  if (!item || !workspace) return null;
  const managerSettings = record(item.managerSettings);
  const projectedManager =
    managerSettings &&
    (managerSettings.visibility === 'public' || managerSettings.visibility === 'invite-only')
      ? {
          visibility: managerSettings.visibility as 'public' | 'invite-only',
          ...field('rooms', readList(managerSettings.rooms, readManagedRoom, ROOM_VIEW_CHAT_LIMIT)),
          ...field(
            'roomsTruncated',
            typeof managerSettings.roomsTruncated === 'boolean'
              ? managerSettings.roomsTruncated
              : undefined,
          ),
        }
      : undefined;
  return {
    workspace: {
      ...workspace,
      createdAt: integer(rawWorkspace?.createdAt) ? Number(rawWorkspace.createdAt) : 0,
      ...field('about', typeof rawWorkspace?.about === 'string' ? rawWorkspace.about : undefined),
    },
    members: readList(item.members, readMember, WORKSPACE_MEMBER_PAGE_SIZE) ?? [],
    agents: readList(item.agents, readWorkspaceAgent, WORKSPACE_MEMBER_PAGE_SIZE) ?? [],
    membersTruncated: typeof item.membersTruncated === 'boolean' ? item.membersTruncated : false,
    agentsTruncated: typeof item.agentsTruncated === 'boolean' ? item.agentsTruncated : false,
    viewer: readViewer(item.viewer),
    watchFilters: readWatchFilters(item.watchFilters),
    ...field('managerSettings', projectedManager),
    ...field('peopleTotal', integer(item.peopleTotal) ? item.peopleTotal : undefined),
    ...field('agentTotal', integer(item.agentTotal) ? item.agentTotal : undefined),
  };
}

export function isWorkspaceView(value: unknown): value is WorkspaceView {
  return readWorkspaceView(value) !== null;
}

export function readWorkspaceMemberListView(value: unknown): WorkspaceMemberListView | null {
  const item = record(value);
  if (!item) return null;
  const members = requireList(item.members, readMember, WORKSPACE_MEMBER_PAGE_SIZE);
  const agents = requireList(item.agents, readWorkspaceAgent, WORKSPACE_MEMBER_PAGE_SIZE);
  if (!members || !agents) return null;
  return {
    members,
    agents,
    membersTruncated: typeof item.membersTruncated === 'boolean' ? item.membersTruncated : false,
    agentsTruncated: typeof item.agentsTruncated === 'boolean' ? item.agentsTruncated : false,
    ...field('grants', readList(item.grants, readWorkspaceMemberGrantView)),
    ...field('peopleTotal', integer(item.peopleTotal) ? item.peopleTotal : undefined),
    ...field('agentTotal', integer(item.agentTotal) ? item.agentTotal : undefined),
  };
}

export function isWorkspaceMemberListView(value: unknown): value is WorkspaceMemberListView {
  return readWorkspaceMemberListView(value) !== null;
}

export function readChatListView(value: unknown): ChatListView | null {
  const item = record(value);
  const workspace = readWorkspace(item?.workspace);
  const viewer = readIdentity(item?.viewer);
  if (!item || !workspace || !viewer) return null;
  const chats = requireList(item.chats, readChat, ROOM_VIEW_CHAT_LIMIT);
  if (!chats) return null;
  return {
    workspace,
    chats,
    viewer,
    truncated: typeof item.truncated === 'boolean' ? item.truncated : false,
    watchFilters: readWatchFilters(item.watchFilters),
  };
}

export function isChatListView(value: unknown): value is ChatListView {
  return readChatListView(value) !== null;
}

export function readCornerListView(value: unknown): CornerListView | null {
  const item = record(value);
  const room = readHeader(item?.room);
  if (!item || !room) return null;
  const corners = requireList(item.corners, readCorner);
  if (!corners) return null;
  return {
    room,
    corners,
    ...field(
      'nextArchived',
      typeof item.nextArchived === 'string' && item.nextArchived.length <= 128
        ? item.nextArchived
        : undefined,
    ),
    ...field('apps', readList(item.apps, readCornerAppInstallation, 100)),
    viewer: readViewer(item.viewer),
    watchFilters: readWatchFilters(item.watchFilters),
  };
}

export function isCornerListView(value: unknown): value is CornerListView {
  return readCornerListView(value) !== null;
}

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
  return {
    workspaceId: item.workspaceId,
    agent,
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

export function isAgentPairingClaimWireView(value: unknown): value is AgentPairingClaimWireView {
  return readAgentPairingClaimWireView(value) !== null;
}

export function readAgentPairingClaimView(value: unknown): AgentPairingClaimView | null {
  const wire = readAgentPairingClaimWireView(value);
  if (!wire) return null;
  return { ...wire, attachedRoomIds: wire.attachedRoomIds ?? [] };
}

export function isAgentPairingClaimView(value: unknown): value is AgentPairingClaimView {
  return readAgentPairingClaimView(value) !== null;
}

export function readAgentPairingAbandonView(value: unknown): AgentPairingAbandonView | null {
  const item = record(value);
  if (!item || typeof item.abandoned !== 'boolean') return null;
  return { abandoned: item.abandoned };
}

export function isAgentPairingAbandonView(value: unknown): value is AgentPairingAbandonView {
  return readAgentPairingAbandonView(value) !== null;
}
