import {
  createAgentCommand,
  reconcileConfiguredCornerReviewers,
  routeHumanMessage,
  turnRootMessageSql,
  type CommandRow,
} from './agent-command.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { GoogleOAuth } from './google-oauth.js';
import { approvedComposioTools, composioScopeForOwner } from './composio-config.js';
import { storeWorkspaceAvatar } from './durable-avatar.js';
import { queueLatestReleasePush } from './release-push-catchup.js';
import { requireRoomSlug, reserveRoomName } from './room-names.js';
import {
  createAgentPairingCode,
  HUMAN_CORNER_TITLE_MAX_LENGTH,
  isServerEventKind,
  ROOM_VIEW_AGENT_LIMIT,
  ROOM_VIEW_BRIEFING_LIMIT,
  ROOM_VIEW_CHAT_LIMIT,
  ROOM_VIEW_MEMBER_LIMIT,
  ROOM_VIEW_MESSAGE_LIMIT,
  ROOM_VIEW_TOOL_ROW_LIMIT,
  WORKSPACE_MEMBER_PAGE_SIZE,
  readCornerAppDefinition,
  readCornerAppManifest,
} from '@beeline/api-contract/phone';
import type {
  AgentGrantView,
  AgentDetailView,
  AgentPairingClaimView,
  ChatListView,
  CornerAppView,
  CornerListView,
  CornerLifecycleView,
  InviteView,
  RoomLiveDelta,
  RoomHistoryView,
  RoomView,
  RoomViewIdentity,
  RoomViewMember,
  RoomViewMessage,
  SystemEvent,
  WorkspaceListView,
  WorkspaceAgentView,
  WorkspaceMemberListQuery,
  WorkspaceMemberListView,
  WorkspaceView,
} from '@beeline/api-contract/phone';
import {
  assignSeededAgentIdentity,
  uniqueAgentHandle,
  cornerDisplayName,
  createCommunityInviteToken,
  defaultFaceForSeed,
  FACE_SOULS,
  isCommunityInviteToken,
  isFaceId,
  MESSAGE_REACTION_EMOJIS,
  resolveFace,
  type PhoneOperationMap,
  isPushLevel,
  type ArtifactAttachment,
} from '@beeline/api-contract/phone';
import {
  isCommandGrantScript,
  type AgentGrantDecision,
  type AgentGrantStatus,
} from '@beeline/api-contract/agent-grants';
import {
  isOfferableConnectorKind,
  type ConnectorOfferCardView,
  type ConnectorOfferStatus,
} from '@beeline/api-contract/connector-offers';
import {
  AGENT_REACHABLE_HORIZON_MS,
  MAX_ACCESS_ALLOWLIST_ENTRIES,
  agentAccessPolicyRecord,
  accessNoticeBucket,
  isAgentAccessPolicy,
  parseAgentAccessPolicy,
  senderMayAddressAgent,
} from '@beeline/api-contract/agent-access';
import {
  resolveCurrentMemberMentions,
  taggedIdentityIdsSql,
  typedMentionHandles,
} from './message-mentions.js';
import { MESSAGE_CURSOR_MS_SQL, type SqlDatabase } from './database.js';
import { tombstoneInstitutionalMemoryForMessage } from './institutional-memory-shadow.js';
import {
  notifyConnectorAssignment,
  notifyConnectorHelper,
  POSTGRES_LIVE_CHANNEL,
} from './postgres-live.js';
import type { CommittedMessageLiveRow, CommittedTurnLiveRow, LiveEvent, LiveHub } from './live.js';
import type { GitHubOperations } from './github-operations.js';
import { collapsePermissionCards } from '@beeline/push-gateway/projection';
import { deriveCornerState } from './corner-state.js';
import { chatCornerCounts } from './chat-corner-counts.js';
const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);
import {
  joinRooms,
  joinWorkspaceMembersToPublicRoom,
  syncTopLevelSharedRoomRoles,
} from './membership-join.js';
import {
  lockIdentityHandleWorkspaces,
  reassignCollidingAgentHandles,
} from './workspace-handles.js';
import { REVIEW_IDENTITY_ID } from './review-access.js';
import {
  directMessageRoomId,
  identitySubject,
  systemIdentityMention,
  systemLine,
  workspaceSystemLine,
} from './system-line.js';
export { directMessageRoomId } from './system-line.js';
import { nextScheduleOccurrence, validateScheduleCadence } from './agent-schedules.js';
import {
  answerRoomChoice,
  hiddenWakeCardSql,
  postRoomChoice,
  skipRoomChoice,
} from './room-choice.js';
import { unreadMessageSql, VIEWER_READ_CURSOR_SQL } from './read-cursor.js';
import {
  connectorCatalog,
  connectorDisplayName,
  connectorIdentityIds,
  defaultConnectorSteps,
  dmParticipantsIncludeConnectorIdentity,
  ensureConnectorDirectMessageRoom,
  grantSquireToOwnerMachineAgents,
  isConnectableConnector,
  isMetadataStale,
} from './workbench.js';
import type {
  ConnectorKind,
  ConnectorStatus,
  ConnectorStep,
} from '@beeline/api-contract/workbench';
import {
  CONNECTOR_ADAPTER_DENIED,
  connectorAdapter,
  connectorRequesterRole,
  faviconDomain,
  isGoogleToolConnectorKind,
} from '@beeline/api-contract/workbench';
import type {
  GrantWalletDelegationInput,
  ReadWalletHistoryInput,
} from '@beeline/api-contract/wallet';
import {
  createWallet,
  readWallet,
  sendFromWallet,
  grantWalletDelegation,
  walletBinding,
  walletHistory,
} from './wallet.js';
import { ARTIFACT_TTL_HOURS, mediaIdFromUrl, mediaTtlHours } from './media-ttl.js';
import type { ObjectService } from './object-service.js';
import { closeCornerState } from './corner-close.js';
import {
  DELETED_ACCOUNT_IDENTITY_ID,
  DELETED_ACCOUNT_NAME,
  SYSTEM_IDENTITY_ID,
} from '@beeline/api-contract/system-identity';

const DURABLE_KINDS = [0, 9, 9000, 9001, 9002, 9007, 9008, 30078, 39000, 39001, 39002];

/**
 * How long after a claim the connect wizard may still rename its agent from
 * the terminal. Long enough for the daemon install and the person to read the
 * line; short enough that a leaked pairing code is not a standing handle.
 */
const CONNECT_RENAME_WINDOW_MS = 15 * 60 * 1_000;
const SLOW_ROOM_READ_MS = 500;
/** Archived corners come ten at a time, newest closure first. */
const ARCHIVED_CORNER_PAGE = 10;

/** Where the next archived page starts: the last row's exact closure time and id. */
export type ArchivedCornerCursor = { readonly micros: string; readonly id: string };

/** Reads a `nextArchived` cursor (`<archived_at µs>,<corner id>`); anything else is not one. */
export function parseArchivedCornerCursor(
  raw: string | null | undefined,
): ArchivedCornerCursor | undefined {
  const parsed = raw?.match(
    /^(\d{1,19}),([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
  return parsed ? { micros: parsed[1]!, id: parsed[2]! } : undefined;
}
export const OPTIONAL_ENRICHMENT_DEADLINE_MS = 1_000;
const ENRICHMENT_LOG_INTERVAL_MS = 60_000;
function normalizeAgentName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 32 || !/^\p{L}[\p{L}\p{M}'’ -]*$/u.test(name))
    throw new Error('agent name must be a short spoken name');
  return name;
}

function normalizeHumanCornerTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new Error('corner title is required');
  if (title.length > HUMAN_CORNER_TITLE_MAX_LENGTH)
    throw new Error(`corner title must be at most ${HUMAN_CORNER_TITLE_MAX_LENGTH} characters`);
  return title;
}

/**
 * Settled corner tool rows kept in the corner transcript after the turn
 * completes (#804). Own cap: they must never crowd out the 30-message
 * conversation window, and top-level Rooms never surface them.
 */
function roomFilters(
  roomId: string,
  workspaceId: string,
  familyIds: readonly string[],
  members: readonly RoomViewMember[],
) {
  const h = [...new Set([workspaceId, roomId, ...familyIds])];
  const authors = [...new Set(members.map((member) => member.identity.pubkey))];
  return [
    { kinds: DURABLE_KINDS, '#h': h },
    ...(authors.length ? [{ kinds: [0], authors }] : []),
    {
      kinds: [30078],
      '#d': [`agent-draft:${roomId}`, `agent-thought:${roomId}`, `agent-presence:${roomId}`],
    },
  ];
}

type Input<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['input'];
type Output<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['output'];

interface IdentityRow {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle: string | null;
  avatar: string | null;
  face_id: string | null;
}
interface RoomRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  created_by: string | null;
  name: string;
  about: string | null;
  avatar: string | null;
  visibility: 'public' | 'invite-only';
  archived_at: Date | null;
  direct_participants: string[] | null;
  repository_key: string | null;
  repository_name: string | null;
  repository_remote: string | null;
  repository_target_branch: string;
  repository_updated_at: Date | null;
  repository_resolution: 'repository' | 'none' | 'unverified';
  github_installation_id: string | null;
  github_events_enabled: boolean;
  reviewer_agent_id: string | null;
  created_at: Date;
  updated_at: Date;
}
interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  text: string;
  presentation: RoomViewMessage['presentation'];
  deleted_at?: Date | null;
  bookmarked?: boolean;
  attachments: unknown[];
  reactions?: Record<string, string[]>;
  reaction_identities?: Array<{
    id: string;
    kind: 'human' | 'agent';
    name: string;
    handle: string | null;
    avatar: string | null;
    face_id: string | null;
  }>;
  /** Derived on read from the row's text and the Room's membership, not stored. */
  tagged_ids: string[];
  reply_to_message_id: string | null;
  root_message_id: string | null;
  request_id: string | null;
  turn_id: string | null;
  agent_model: string | null;
  activity: unknown[] | null;
  durable_fact: RoomViewMessage['durableFact'] | null;
  card_type: string | null;
  card: Record<string, unknown> | null;
  system_event: SystemEvent | null;
  created_at: Date;
  author_kind: 'human' | 'agent';
  author_name: string;
  author_handle: string | null;
  author_avatar: string | null;
  author_face: string | null;
}
interface AgentTurnRow {
  request_id: string;
  agent_id: string;
  status: 'working' | 'complete' | 'failed' | 'cancelled';
  started_at: Date;
  created_at: Date;
  generation_id: string | null;
  requested_by: string | null;
}
interface MemberRow extends IdentityRow {
  role: 'owner' | 'admin' | 'member' | 'spectator';
  presence_body: { status: 'online' | 'offline'; observedAt: number } | null;
  presence_updated_at: Date | null;
}
interface CornerRow extends RoomRow {
  lifecycle: RoomView['cornerLifecycle'] | null;
  objective: string | null;
  initiator_id: string | null;
  initiator_name: string | null;
  initiator_handle: string | null;
  initiator_avatar: string | null;
  initiator_face: string | null;
  latest_id: string | null;
  latest_text: string | null;
  latest_created_at: Date | null;
  latest_author_id: string | null;
  latest_author_kind: 'human' | 'agent' | null;
  latest_author_name: string | null;
  latest_tags_viewer: boolean | null;
  /** `archived_at` in whole microseconds, exact, for the archived page cursor. */
  archived_us: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_handle: string | null;
  agent_avatar: string | null;
  latest_turn_status: 'working' | 'complete' | 'failed' | null;
  latest_turn_created_at: Date | null;
  app_installation_id: string | null;
  app_instance_id: string | null;
  app_manifest: unknown | null;
}
interface TopLevelRoomReadRow {
  room: RoomRow & {
    viewer_role: 'owner' | 'admin' | 'member' | 'spectator';
    workspace_role: 'owner' | 'admin' | 'member' | 'spectator';
    read_cursor: RoomView['viewer']['readCursor'] | null;
  };
  members: MemberRow[];
  turns: AgentTurnRow[];
  transcript: MessageRow[];
  activity: MessageRow[];
}
interface RoomScheduleRow {
  id: string;
  workspace_id: string;
  room_id: string;
  agent_id: string;
  creator_id: string;
  cadence: Input<'createRoomSchedule'>['cadence'];
  message: string;
  next_run_at: Date;
  created_at: Date;
  surface_parent_id?: string | null;
  surface_name?: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}
function messageId(): string {
  return randomBytes(32).toString('hex');
}
function unix(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}
function messageOrder(left: RoomViewMessage, right: RoomViewMessage): number {
  return (
    (left.createdAtMs ?? left.createdAt * 1_000) - (right.createdAtMs ?? right.createdAt * 1_000) ||
    left.id.localeCompare(right.id)
  );
}
function reviveDates<Row extends object>(row: Row, fields: readonly string[]): Row {
  const mutable = row as Record<string, unknown>;
  for (const field of fields) {
    const value = mutable[field];
    if (typeof value === 'string') mutable[field] = new Date(value);
  }
  return row;
}
function assetUrl(value: string, publicOrigin: string) {
  return value.startsWith('/') ? `${publicOrigin}${value}` : value;
}
function identity(row: IdentityRow, publicOrigin: string): RoomViewIdentity {
  return {
    pubkey: row.id,
    kind: row.kind,
    name: row.name,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.avatar ? { avatar: assetUrl(row.avatar, publicOrigin) } : {}),
    ...(row.face_id ? { face: row.face_id } : {}),
  };
}

function selectedModelLabel(
  selected: string | null,
  catalog: AgentDetailView['catalog'],
): string | undefined {
  const axis = catalog.find((candidate) => candidate.category === 'model');
  const value = selected ?? axis?.currentValue;
  if (!value) return undefined;
  return axis?.options?.find((option) => option.id === value)?.name ?? value;
}
function roomHeader(row: RoomRow, publicOrigin: string) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    name: row.name,
    ...(row.about ? { about: row.about } : {}),
    ...(row.avatar ? { avatar: assetUrl(row.avatar, publicOrigin) } : {}),
    visibility: row.visibility,
    ...(row.reviewer_agent_id ? { reviewerAgentId: row.reviewer_agent_id } : {}),
    archived: Boolean(row.archived_at),
    createdAt: unix(row.created_at),
    updatedAt: unix(row.updated_at),
  };
}

/**
 * Stamp `expired` on every attachment whose media id has a tombstone
 * (`media-ttl.ts`). The message row is never edited: name, type and size stay
 * exactly as they were posted, and the client renders the loss rather than
 * guessing at a 410 it has not made yet.
 */
function withAttachmentExpiry<Message extends RoomViewMessage>(
  messages: readonly Message[],
  expired: ReadonlySet<string>,
): Message[] {
  if (!expired.size) return [...messages];
  return messages.map((message) => {
    if (!message.attachments?.length) return message;
    const attachments = message.attachments.map((attachment) => {
      const id = mediaIdFromUrl(attachment.url);
      return id && expired.has(id) ? { ...attachment, expired: true } : attachment;
    });
    return attachments.some((attachment, index) => attachment !== message.attachments![index])
      ? { ...message, attachments }
      : message;
  });
}

/**
 * Stamp artifact-card facts onto attachments whose media id names a ready
 * object row: `{ kind:'artifact', title, author }` alongside the mime and size
 * the attachment already carries. Person file shares and agent artifacts
 * share this card. The message row is never edited.
 */
function withArtifactFacts<Message extends RoomViewMessage>(
  messages: readonly Message[],
  artifacts: ReadonlyMap<string, ArtifactAttachment>,
): Message[] {
  if (!artifacts.size) return [...messages];
  return messages.map((message) => {
    if (!message.attachments?.length) return message;
    const attachments = message.attachments.map((attachment) => {
      const id = mediaIdFromUrl(attachment.url);
      const artifact = id ? artifacts.get(id) : undefined;
      return artifact ? { ...attachment, ...artifact } : attachment;
    });
    return attachments.some((attachment, index) => attachment !== message.attachments![index])
      ? { ...message, attachments }
      : message;
  });
}

/** Expiry tombstones and artifact facts, collected in one read. */
interface AttachmentFacts {
  expired: ReadonlySet<string>;
  artifacts: ReadonlyMap<string, ArtifactAttachment>;
}

/** Both attachment decorations in one place, so no read path forgets one. */
function decorateAttachments<Message extends RoomViewMessage>(
  messages: readonly Message[],
  facts: AttachmentFacts,
): Message[] {
  return withArtifactFacts(withAttachmentExpiry(messages, facts.expired), facts.artifacts);
}

function projectedMessage(
  row: MessageRow,
  publicOrigin: string,
  viewerId?: string,
): RoomViewMessage {
  const author = identity(
    {
      id: row.author_id,
      kind: row.author_kind,
      name: row.author_name,
      handle: row.author_handle,
      avatar: row.author_avatar,
      face_id: row.author_face,
    },
    publicOrigin,
  );
  const reactionIdentityById = new Map(
    (row.reaction_identities ?? []).map((reactor) => [reactor.id, reactor]),
  );
  const base: RoomViewMessage = {
    id: row.id,
    text: row.deleted_at ? 'Message deleted' : row.text,
    createdAt: unix(row.created_at),
    createdAtMs: row.created_at.getTime(),
    author,
    presentation: row.presentation,
    ...(row.deleted_at ? { deleted: true } : {}),
    ...(row.bookmarked ? { bookmarked: true } : {}),
    ...(row.presentation === 'message'
      ? {
          reference: {
            channelId: row.room_id,
            eventId: row.id,
            rootId: row.root_message_id ?? row.id,
          },
        }
      : {}),
    ...(row.request_id
      ? { requestId: row.request_id, liveTurnId: row.turn_id ?? `live-turn:${row.request_id}` }
      : {}),
    ...(!row.deleted_at && row.attachments.length
      ? {
          attachments: (row.attachments as NonNullable<RoomViewMessage['attachments']>).map(
            (attachment) => ({
              ...attachment,
              url: attachment.url.startsWith('/')
                ? `${publicOrigin}${attachment.url}`
                : attachment.url,
              ...(attachment.previewUrl?.startsWith('/')
                ? { previewUrl: `${publicOrigin}${attachment.previewUrl}` }
                : {}),
              ...(attachment.thumbnailUrl?.startsWith('/')
                ? { thumbnailUrl: `${publicOrigin}${attachment.thumbnailUrl}` }
                : {}),
            }),
          ),
        }
      : {}),
    ...(!row.deleted_at && row.tagged_ids.length ? { mentionPubkeys: row.tagged_ids } : {}),
    ...(row.agent_model ? { agentModel: row.agent_model } : {}),
    ...(!row.deleted_at && Object.keys(row.reactions ?? {}).length
      ? {
          reactions: MESSAGE_REACTION_EMOJIS.flatMap((emoji) => {
            const reactors = (row.reactions ?? {})[emoji] ?? [];
            return reactors.length
              ? [
                  {
                    emoji,
                    count: reactors.length,
                    reacted: viewerId ? reactors.includes(viewerId) : false,
                    members: reactors.flatMap((reactorId) => {
                      const reactor = reactionIdentityById.get(reactorId);
                      return reactor ? [identity(reactor, publicOrigin)] : [];
                    }),
                  },
                ]
              : [];
          }),
        }
      : {}),
    ...(row.reply_to_message_id
      ? {
          reply: {
            channelId: row.room_id,
            eventId: row.reply_to_message_id,
            rootId: row.root_message_id ?? row.reply_to_message_id,
          },
        }
      : {}),
    ...(row.activity ? { activity: row.activity as NonNullable<RoomViewMessage['activity']> } : {}),
    ...(row.durable_fact ? { durableFact: row.durable_fact } : {}),
    ...(row.system_event ? { systemEvent: row.system_event } : {}),
  };
  if (!row.card_type || !row.card) return base;
  switch (row.card_type) {
    case 'relay':
      return { ...base, relay: row.card as NonNullable<RoomViewMessage['relay']> };
    case 'permission':
      return { ...base, permission: row.card as NonNullable<RoomViewMessage['permission']> };
    case 'grant-request':
      return { ...base, grantRequest: row.card as NonNullable<RoomViewMessage['grantRequest']> };
    case 'squire-approval':
      return { ...base, squireApproval: row.card as NonNullable<RoomViewMessage['squireApproval']> };
    case 'connector-offer':
      return {
        ...base,
        connectorOffer: row.card as NonNullable<RoomViewMessage['connectorOffer']>,
      };
    case 'choice':
      return { ...base, choice: row.card as NonNullable<RoomViewMessage['choice']> };
    case 'wallet-tx':
      return { ...base, walletTx: row.card as NonNullable<RoomViewMessage['walletTx']> };
    case 'wallet-insufficient':
      return {
        ...base,
        walletInsufficient: row.card as NonNullable<RoomViewMessage['walletInsufficient']>,
      };
    case 'wallet-delegation':
      return {
        ...base,
        walletDelegation: row.card as NonNullable<RoomViewMessage['walletDelegation']>,
      };
    case 'target-branch':
      return { ...base, targetBranch: row.card as NonNullable<RoomViewMessage['targetBranch']> };
    case 'github-event':
      return { ...base, githubEvent: row.card as NonNullable<RoomViewMessage['githubEvent']> };
    case 'daemon-fact':
      return { ...base, daemonFact: titledDaemonFact(row.card) };
    case 'corner':
      return { ...base, corner: row.card as NonNullable<RoomViewMessage['corner']> };
    case 'corner-app':
      return { ...base, cornerApp: row.card as NonNullable<RoomViewMessage['cornerApp']> };
    default:
      return base;
  }
}

/** Canonical reactor identities, kept beside each bounded message row so every
 * Room/history projection can paint the same roster without a client lookup. */
function reactionIdentitiesSql(messageAlias: string): string {
  return `COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',reactor.id,
      'kind',reactor.kind,
      'name',reactor.name,
      'handle',reactor.handle,
      'avatar',reactor.avatar,
      'face_id',reactor.face_id
    ) ORDER BY reactor.id)
    FROM identities reactor
    WHERE reactor.id IN (
      SELECT jsonb_array_elements_text(reaction.value)
      FROM jsonb_each(${messageAlias}.reactions) reaction
    )
  ),'[]'::jsonb)`;
}

/**
 * Every corner card is titled by its NAME. A card written before the name
 * existed carries only the objective, so its first three words stand in and
 * nothing in the app is ever drawn with a blank title (C89).
 */
function titledDaemonFact(card: unknown): NonNullable<RoomViewMessage['daemonFact']> {
  const fact = card as NonNullable<RoomViewMessage['daemonFact']>;
  const title = cornerDisplayName(fact.name ?? fact.objective);
  return title ? { ...fact, name: title } : fact;
}

function roomSchedule(row: RoomScheduleRow): Output<'createRoomSchedule'> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    agentId: row.agent_id,
    creatorId: row.creator_id,
    cadence: row.cadence,
    message: row.message,
    nextRunAt: unix(row.next_run_at),
    createdAt: unix(row.created_at),
    ...(row.surface_parent_id && row.surface_name
      ? { corner: { id: row.room_id, name: row.surface_name } }
      : {}),
  };
}

export class PhoneService {
  private readonly lastEnrichmentLogAt = new Map<string, number>();

  constructor(
    private readonly database: SqlDatabase,
    private readonly publicOrigin: string,
    private readonly github?: GitHubOperations,
    private readonly sendPushTest?: (identityId: string) => Promise<void>,
    private readonly live?: LiveHub,
    private readonly routingTransaction = false,
    private readonly enrichmentDatabase: SqlDatabase = database,
    private readonly objects?: ObjectService,
    private readonly googleOAuth?: GoogleOAuth,
  ) {}

  private async optionalEnrichment<T>(name: string, work: Promise<T>): Promise<T | undefined> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`optional ${name} enrichment timed out`)),
            OPTIONAL_ENRICHMENT_DEADLINE_MS,
          );
          deadline.unref?.();
        }),
      ]);
    } catch (error) {
      const now = Date.now();
      if (now - (this.lastEnrichmentLogAt.get(name) ?? 0) >= ENRICHMENT_LOG_INTERVAL_MS) {
        this.lastEnrichmentLogAt.set(name, now);
        console.warn(
          '[room-enrichment-degraded]',
          JSON.stringify({
            enrichment: name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return undefined;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  canReadRoom(roomId: string, identityId: string): Promise<boolean> {
    return this.hasRoomAccess(roomId, identityId);
  }

  /** One membership query for a live subscribe batch (Room deck watchFilters). */
  async canReadRooms(roomIds: readonly string[], identityId: string): Promise<ReadonlySet<string>> {
    const unique = [...new Set(roomIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0) return new Set();
    const result = await this.database.query<{ room_id: string }>(
      `SELECT room_member.room_id::text AS room_id FROM memberships room_member
       JOIN rooms room ON room.id=room_member.room_id
       WHERE room_member.room_id = ANY($1::uuid[]) AND room_member.identity_id=$2
         AND room_member.removed_at IS NULL
         AND ($2=$3 OR EXISTS(
           SELECT 1 FROM memberships workspace_member
           WHERE workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
         ))`,
      [unique, identityId, SYSTEM_IDENTITY_ID],
    );
    return new Set(result.rows.map((row) => row.room_id));
  }

  /** Project a row the daemon's committing transaction already returned. The
   * socket subscription performed the Room access check; cross-process hints
   * still use readLiveDelta, which rechecks current membership. */
  projectCommittedLiveDelta(
    roomId: string,
    committed:
      | { type: 'message'; row: CommittedMessageLiveRow }
      | { type: 'turn'; row: CommittedTurnLiveRow },
  ): RoomLiveDelta | null {
    if (committed.row.room_id !== roomId) return null;
    if (committed.type === 'turn') {
      const turn = this.projectAgentTurns([committed.row])[0];
      return turn ? { type: 'turn-delta', roomId, turn } : null;
    }
    return {
      type: 'message-delta',
      roomId,
      message: projectedMessage(committed.row, this.publicOrigin),
    };
  }

  /** One committed row for the live paint path, behind the same two membership
   * bounds as a full Room read. A missing/hidden row falls back to the ordinary
   * reconciliation read at the caller. */
  async readLiveDelta(
    roomId: string,
    viewerId: string,
    target:
      { type: 'message'; messageId: string } | { type: 'turn'; agentId: string; requestId: string },
  ): Promise<RoomLiveDelta | null> {
    if (target.type === 'turn') {
      const row = (
        await this.database.query<AgentTurnRow>(
          `SELECT turn.request_id,turn.agent_id,turn.status,turn.started_at,turn.created_at,turn.generation_id,
             requester.id requested_by
           FROM rooms room
           JOIN memberships member ON member.room_id=room.id AND member.identity_id=$2
             AND member.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           JOIN agent_turns turn ON turn.room_id=room.id AND turn.agent_id=$3
           LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('turn')}
           LEFT JOIN identities requester ON requester.id=trigger.author_id
             AND requester.kind='human'
           WHERE room.id=$1
           ORDER BY turn.created_at DESC,turn.request_id DESC LIMIT 1`,
          [roomId, viewerId, target.agentId],
        )
      ).rows[0];
      if (!row || row.request_id !== target.requestId) return null;
      return { type: 'turn-delta', roomId, turn: this.projectAgentTurns([row])[0]! };
    }
    const row = (
      await this.database.query<MessageRow>(
        `SELECT message.*,author.kind author_kind,author.name author_name,
           author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
           ${reactionIdentitiesSql('message')} reaction_identities,
           ${taggedIdentityIdsSql('message')} tagged_ids
         FROM rooms room
         JOIN memberships member ON member.room_id=room.id AND member.identity_id=$3
           AND member.removed_at IS NULL
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
           AND workspace_member.removed_at IS NULL
         JOIN messages message ON message.room_id=room.id AND message.id=$2
         JOIN identities author ON author.id=message.author_id
         WHERE room.id=$1 AND ${hiddenWakeCardSql('message')}
           AND (
             message.presentation<>'activity' OR message.durable_fact IS NOT NULL OR EXISTS(
               SELECT 1 FROM agent_turns turn
               WHERE turn.room_id=room.id AND turn.agent_id=message.author_id
                 AND turn.status='working'
                 AND date_trunc('second',message.created_at)>=date_trunc('second',turn.created_at)
                 AND NOT EXISTS(
                   SELECT 1 FROM agent_turns newer
                   WHERE newer.room_id=turn.room_id AND newer.agent_id=turn.agent_id
                     AND (newer.created_at,newer.request_id)>(turn.created_at,turn.request_id)
                 )
             )
           )`,
        [roomId, target.messageId, viewerId],
      )
    ).rows[0];
    if (!row) return null;
    const message = projectedMessage(row, this.publicOrigin, viewerId);
    return {
      type: 'message-delta',
      roomId,
      message: decorateAttachments([message], await this.attachmentFacts([message]))[0]!,
    };
  }

  /**
   * The live draft a joining reader has already missed.
   *
   * `LiveHub` is publish-only: a socket receives what is written after it
   * subscribes, and `live_outputs` — which holds the running text — was never
   * offered to anyone who was not already listening. A top-level Room hides
   * that, because its turn writes a fresh whole-answer snapshot every few
   * hundred milliseconds and repaints a late reader almost immediately. A
   * corner turn spends minutes inside tool calls between assistant runs, so
   * the same reader sits in front of the collapsed tool group and the clock
   * with no prose at all for as long as the tools run.
   *
   * Bounded by the turn receipt on exactly the rule the phone uses to call a
   * turn active (`AGENT_TURN_FRESHNESS_MS`, 90s, kept inside itself by the
   * daemon's 30s heartbeat and by every activity row it posts): a finished or
   * abandoned turn never has its draft resurrected.
   */
  async liveDraftSnapshot(roomId: string): Promise<LiveEvent[]> {
    const rows = await this.database.query<{
      agent_id: string;
      turn_id: string;
      body: { text?: unknown } | null;
    }>(
      `SELECT o.agent_id, o.turn_id, o.body FROM live_outputs o
       JOIN rooms r ON r.id=o.room_id AND r.parent_id IS NOT NULL
       JOIN agent_turns t ON t.room_id=o.room_id AND t.request_id=o.turn_id AND t.agent_id=o.agent_id
       WHERE o.room_id=$1 AND o.kind='draft'
         AND t.status='working' AND t.created_at>now()-interval '90 seconds'
       ORDER BY o.updated_at`,
      [roomId],
    );
    return rows.rows.flatMap((row) => {
      const text = typeof row.body?.text === 'string' ? row.body.text : '';
      return text
        ? [
            {
              type: 'draft' as const,
              roomId,
              agentId: row.agent_id,
              turnId: row.turn_id,
              text,
            },
          ]
        : [];
    });
  }

  async readWorkspaces(viewerId: string): Promise<WorkspaceListView> {
    const rows = await this.database.query<{
      id: string;
      name: string;
      avatar: string | null;
      visibility: 'public' | 'invite-only';
      role: 'owner' | 'admin' | 'member' | 'spectator';
      updated_at: Date;
    }>(
      `SELECT w.id, w.name, w.avatar, w.visibility, m.role, w.updated_at
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.identity_id = $1 AND m.room_id IS NULL AND m.removed_at IS NULL
       ORDER BY w.updated_at DESC, w.id LIMIT 51`,
      [viewerId],
    );
    const deletedNotices = await this.database.query<{
      id: string;
      workspace_id: string;
      workspace_name: string;
    }>(
      `DELETE FROM workspace_deletion_notices WHERE identity_id=$1
       RETURNING id,workspace_id,workspace_name`,
      [viewerId],
    );
    return {
      workspaces: rows.rows.slice(0, 50).map((row) => ({
        id: row.id,
        name: row.name,
        ...(row.avatar ? { avatar: assetUrl(row.avatar, this.publicOrigin) } : {}),
        visibility: row.visibility,
        role: row.role,
        updatedAt: unix(row.updated_at),
      })),
      viewer: await this.requireIdentity(viewerId),
      truncated: rows.rows.length > 50,
      watchFilters: [],
      ...(deletedNotices.rows.length
        ? {
            deletedNotices: deletedNotices.rows.map((row) => ({
              workspaceId: row.workspace_id,
              workspaceName: row.workspace_name,
            })),
          }
        : {}),
    };
  }

  async readWorkspace(workspaceId: string, viewerId: string): Promise<WorkspaceView | null> {
    const workspace = await this.database.query<{
      id: string;
      name: string;
      about: string | null;
      avatar: string | null;
      visibility: 'public' | 'invite-only';
      created_at: Date;
      updated_at: Date;
      role: 'owner' | 'admin' | 'member' | 'spectator';
    }>(
      `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL
       WHERE w.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL`,
      [workspaceId, viewerId],
    );
    const row = workspace.rows[0];
    if (!row) return null;
    const managedRoomRows =
      row.role === 'owner' || row.role === 'admin'
        ? (
            await this.database.query<{
              id: string;
              name: string;
              visibility: 'public' | 'invite-only';
              created_at: Date;
            }>(
              `SELECT id,name,visibility,created_at FROM rooms
               WHERE workspace_id=$1 AND parent_id IS NULL AND direct_participants IS NULL
                 AND archived_at IS NULL
               -- Fetch one extra row to expose the server-owned 200-Room settings bound.
               ORDER BY lower(name),name,id LIMIT $2`,
              [workspaceId, ROOM_VIEW_CHAT_LIMIT + 1],
            )
          ).rows
        : undefined;
    const managedRooms = managedRoomRows?.slice(0, ROOM_VIEW_CHAT_LIMIT).map((room) => ({
      id: room.id,
      name: room.name,
      visibility: room.visibility,
      createdAt: unix(room.created_at),
    }));
    const roster = await this.workspaceRoster(workspaceId);
    const viewerIdentity = await this.requireIdentity(viewerId);
    return {
      workspace: {
        id: row.id,
        name: row.name,
        ...(row.avatar ? { avatar: assetUrl(row.avatar, this.publicOrigin) } : {}),
        visibility: row.visibility,
        role: row.role,
        updatedAt: unix(row.updated_at),
        ...(row.about ? { about: row.about } : {}),
        createdAt: unix(row.created_at),
      },
      ...(managedRooms
        ? {
            managerSettings: {
              visibility: row.visibility,
              rooms: managedRooms,
              roomsTruncated: managedRoomRows!.length > ROOM_VIEW_CHAT_LIMIT,
            },
          }
        : {}),
      members: roster.members,
      agents: roster.agents,
      peopleTotal: roster.peopleTotal,
      agentTotal: roster.agentTotal,
      membersTruncated: roster.membersTruncated,
      agentsTruncated: roster.agentsTruncated,
      viewer: {
        identity: viewerIdentity,
        role: row.role,
        permissions: {
          send: row.role !== 'spectator',
          manage: row.role === 'owner' || row.role === 'admin',
        },
      },
      watchFilters: [],
    };
  }

  async readWorkspaceMembers(
    workspaceId: string,
    viewerId: string,
    query: WorkspaceMemberListQuery = {},
  ): Promise<WorkspaceMemberListView | null> {
    const access = await this.database.query(
      `SELECT 1 FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [workspaceId, viewerId],
    );
    if (!access.rowCount) return null;
    if (query.memberId) {
      const members = await this.members(workspaceId, null, query.memberId);
      return {
        members: members.filter((m) => m.identity.kind === 'human'),
        agents: [],
        membersTruncated: false,
        agentsTruncated: false,
      };
    }
    return this.workspaceRoster(workspaceId, query);
  }

  async readChats(workspaceId: string, viewerId: string): Promise<ChatListView | null> {
    const workspace = await this.database.query<{
      id: string;
      name: string;
      avatar: string | null;
      visibility: 'public' | 'invite-only';
      role: 'owner' | 'admin' | 'member' | 'spectator';
      updated_at: Date;
    }>(
      `SELECT w.id,w.name,w.avatar,w.visibility,w.updated_at,wm.role FROM workspaces w JOIN memberships wm ON wm.workspace_id=w.id AND wm.room_id IS NULL
       WHERE w.id=$1 AND wm.identity_id=$2 AND wm.removed_at IS NULL`,
      [workspaceId, viewerId],
    );
    const current = workspace.rows[0];
    if (!current) return null;
    const rooms = await this.database.query<
      RoomRow & {
        member_count: string;
        latest_id: string | null;
        latest_text: string | null;
        latest_attachments: MessageRow['attachments'] | null;
        latest_created_at: Date | null;
        latest_author_id: string | null;
        latest_author_kind: 'human' | 'agent' | null;
        latest_author_name: string | null;
        latest_author_handle: string | null;
        latest_author_avatar: string | null;
        latest_author_face: string | null;
        latest_tags_viewer: boolean;
        attention_actor_name: string | null;
        peer_id: string | null;
        peer_kind: 'human' | 'agent' | null;
        peer_name: string | null;
        peer_handle: string | null;
        peer_avatar: string | null;
        peer_face: string | null;
        peer_presence_body: Record<string, unknown> | null;
        peer_presence_updated_at: Date | null;
        peer_activity_at: Date | null;
        unread: boolean;
        working: boolean;
        needs_you: boolean;
        closed: boolean;
        agents_offline: boolean;
      }
    >(
      `
      SELECT r.*,
        (SELECT count(*)::text FROM memberships rm WHERE rm.room_id=r.id AND rm.removed_at IS NULL) member_count,
        lm.id latest_id,lm.text latest_text,lm.attachments latest_attachments,lm.created_at latest_created_at,lm.author_id latest_author_id,
        $2=ANY(${taggedIdentityIdsSql('lm')}) latest_tags_viewer,
        li.kind latest_author_kind,li.name latest_author_name,li.handle latest_author_handle,li.avatar latest_author_avatar,li.face_id latest_author_face,
        attention_actor.name attention_actor_name,
        peer.id peer_id,peer.kind peer_kind,peer.name peer_name,peer.handle peer_handle,peer.avatar peer_avatar,peer.face_id peer_face,
        NULL::jsonb peer_presence_body,NULL::timestamptz peer_presence_updated_at,
        NULL::timestamptz peer_activity_at,false unread,
        false agents_offline,
        EXISTS(SELECT 1 FROM agent_turns t WHERE (t.room_id=r.id OR t.room_id IN (SELECT id FROM rooms WHERE parent_id=r.id AND archived_at IS NULL)) AND t.status='working') working,
        EXISTS(SELECT 1 FROM permission_authority p WHERE (p.room_id=r.id OR p.room_id IN (SELECT id FROM rooms WHERE parent_id=r.id)) AND p.status='pending') needs_you,
        (r.direct_participants IS NOT NULL AND EXISTS(
          SELECT 1 FROM chat_dismissals dismissal
          WHERE dismissal.room_id=r.id AND dismissal.identity_id=$2
            AND NOT EXISTS(
              SELECT 1 FROM messages incoming
              WHERE incoming.room_id=r.id
                AND incoming.author_id IS DISTINCT FROM $2
                AND incoming.presentation IN ('message','system','card')
                AND incoming.created_at>dismissal.dismissed_at
            )
        )) closed
      FROM rooms r
      JOIN memberships member ON member.room_id=r.id AND member.identity_id=$2 AND member.removed_at IS NULL
      LEFT JOIN LATERAL (
        SELECT * FROM messages
        WHERE room_id=r.id AND presentation IN ('message','system','card')
          AND ${hiddenWakeCardSql()}
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) lm ON true
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN LATERAL (
        SELECT agent.name
        FROM permission_authority permission
        LEFT JOIN LATERAL (
          SELECT message.card FROM messages message
          WHERE message.room_id=permission.room_id AND message.card_type='permission'
            AND message.card->>'permissionId'=permission.permission_id
          ORDER BY message.created_at DESC,message.id DESC LIMIT 1
        ) permission_card ON true
        LEFT JOIN identities agent ON agent.id=permission_card.card->'agent'->>'pubkey'
        WHERE permission.status='pending'
          AND (permission.room_id=r.id OR permission.room_id IN (
            SELECT id FROM rooms WHERE parent_id=r.id
          ))
        ORDER BY permission.updated_at DESC LIMIT 1
      ) attention_actor ON true
      LEFT JOIN identities peer ON jsonb_typeof(r.direct_participants)='array'
        AND peer.id=(SELECT p FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(r.direct_participants)='array' THEN r.direct_participants ELSE '[]'::jsonb END
        ) p WHERE p<>$2 LIMIT 1)
      WHERE r.workspace_id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
        AND (
          r.direct_participants IS NULL OR peer.id IS NULL
          OR NOT (peer.id = ANY($3::text[])) OR lm.id IS NOT NULL
        )
      ORDER BY COALESCE(lm.created_at,r.updated_at) DESC,r.id LIMIT 201`,
      [workspaceId, viewerId, connectorIdentityIds()],
    );
    const roomIds = rooms.rows.map((room) => room.id);
    const [presence, cursors, cornerStates] = await Promise.all([
      this.optionalEnrichment(
        'chat-presence',
        this.enrichmentDatabase.query<{
          room_id: string;
          peer_presence_body: Record<string, unknown> | null;
          peer_presence_updated_at: Date | null;
          peer_activity_at: Date | null;
          agents_offline: boolean;
        }>(
          `SELECT room.id room_id,presence.body peer_presence_body,
             presence.updated_at peer_presence_updated_at,
             GREATEST(
               (SELECT max(message.created_at) FROM messages message
                WHERE message.room_id=room.id AND message.author_id=peer.id),
               (SELECT max(mark.updated_at) FROM room_read_marks mark
                WHERE mark.room_id=room.id AND mark.identity_id=peer.id)
             ) peer_activity_at,
             agent_presence.agent_count > 0
               AND agent_presence.known_presence_count = agent_presence.agent_count
               AND agent_presence.online_agent_count = 0 agents_offline
           FROM rooms room
           LEFT JOIN identities peer ON peer.id=(SELECT participant FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(room.direct_participants)='array'
               THEN room.direct_participants ELSE '[]'::jsonb END
           ) participant WHERE participant<>$2 LIMIT 1)
           LEFT JOIN LATERAL(
             SELECT body,updated_at FROM live_outputs
             WHERE agent_id=peer.id AND kind='presence' ORDER BY updated_at DESC LIMIT 1
           ) presence ON peer.kind='agent'
           LEFT JOIN LATERAL(
             SELECT count(*)::int agent_count,
               count(agent_status.body)::int known_presence_count,
               count(*) FILTER(
                 WHERE agent_status.body->>'status'='online'
                   AND agent_status.updated_at>$3
               )::int online_agent_count
             FROM memberships member
             JOIN identities agent ON agent.id=member.identity_id
               AND agent.kind='agent' AND agent.hidden_from_roster=false
             LEFT JOIN LATERAL(
               SELECT body,updated_at FROM live_outputs
               WHERE agent_id=member.identity_id AND kind='presence'
               ORDER BY updated_at DESC LIMIT 1
             ) agent_status ON true
             WHERE member.room_id=room.id AND member.removed_at IS NULL
           ) agent_presence ON true
           WHERE room.id=ANY($1::uuid[])`,
          [roomIds, viewerId, new Date(Date.now() - AGENT_REACHABLE_HORIZON_MS)],
        ),
      ),
      this.optionalEnrichment(
        'chat-read-cursor',
        this.enrichmentDatabase.query<{ room_id: string; unread: boolean }>(
          `SELECT room.id room_id,(latest.id IS NOT NULL AND (
             mark.message_created_at IS NULL OR latest.id<>mark.message_id AND
             (latest.created_at,latest.id)>(mark.message_created_at,mark.message_id)
           )) unread
           FROM rooms room
           LEFT JOIN room_read_marks mark ON mark.room_id=room.id AND mark.identity_id=$2
           LEFT JOIN LATERAL(
             -- The deck's boolean and the Room's cursor now ask one question.
             SELECT message.id,message.created_at FROM messages message
             WHERE message.room_id=room.id AND ${unreadMessageSql('message')}
             ORDER BY message.created_at DESC,message.id DESC LIMIT 1
           ) latest ON true
           WHERE room.id=ANY($1::uuid[])`,
          [roomIds, viewerId],
        ),
      ),
      this.optionalEnrichment(
        'chat-corner-counts',
        this.enrichmentDatabase.query<{
          id: string;
          name: string;
          parent_id: string;
          archived_at: Date | null;
          lifecycle: CornerLifecycleView | null;
          latest_turn_status: string | null;
          commissioned_by_viewer: boolean | null;
          latest_tags_viewer: boolean | null;
        }>(
          `SELECT c.id,c.name,c.parent_id,c.archived_at,f.lifecycle,turn.status latest_turn_status,
           initiator.id=$2 commissioned_by_viewer,
           $2=ANY(${taggedIdentityIdsSql('lm')}) latest_tags_viewer
         FROM rooms c LEFT JOIN corner_facts f ON f.corner_id=c.id
         LEFT JOIN identities initiator
           ON initiator.id=f.commissioned_by AND initiator.kind='human'
         LEFT JOIN LATERAL (SELECT * FROM messages WHERE room_id=c.id AND presentation IN ('message','system') ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
         LEFT JOIN LATERAL (
           SELECT status FROM agent_turns WHERE room_id=c.id
           ORDER BY created_at DESC LIMIT 1
         ) turn ON true
         WHERE c.parent_id=ANY($1::uuid[]) AND c.archived_at IS NULL AND EXISTS (
           SELECT 1 FROM memberships member WHERE member.room_id=c.id
             AND member.identity_id=$2 AND member.removed_at IS NULL
         )
         ORDER BY c.created_at DESC,c.id`,
          [roomIds, viewerId],
        ),
      ),
    ]);
    const countsByRoom = chatCornerCounts(cornerStates?.rows ?? []);
    const presenceByRoom = new Map(presence?.rows.map((item) => [item.room_id, item]) ?? []);
    const cursorByRoom = new Map(cursors?.rows.map((item) => [item.room_id, item]) ?? []);
    for (const room of rooms.rows) {
      const item = presenceByRoom.get(room.id);
      room.peer_presence_body = item?.peer_presence_body ?? null;
      room.peer_presence_updated_at = item?.peer_presence_updated_at ?? null;
      room.peer_activity_at = item?.peer_activity_at ?? null;
      room.agents_offline = item?.agents_offline ?? false;
      room.unread = cursorByRoom.get(room.id)?.unread ?? false;
    }
    return {
      workspace: {
        id: current.id,
        name: current.name,
        ...(current.avatar ? { avatar: assetUrl(current.avatar, this.publicOrigin) } : {}),
        visibility: current.visibility,
        role: current.role,
        updatedAt: unix(current.updated_at),
      },
      chats: rooms.rows.slice(0, 200).map((row) => ({
        room: roomHeader(row, this.publicOrigin),
        ...(row.agents_offline ? { agentsOffline: true } : {}),
        ...(row.closed ? { closed: true } : {}),
        memberCount: Number(row.member_count),
        ...(countsByRoom.get(row.id) ?? { cornerCount: 0, waitingCornerCount: 0 }),
        ...(row.latest_id &&
        row.latest_created_at &&
        row.latest_author_id &&
        row.latest_author_kind &&
        row.latest_author_name
          ? {
              latestMessage: {
                id: row.latest_id,
                text: row.latest_text ?? '',
                createdAt: unix(row.latest_created_at),
                ...(row.latest_attachments?.length
                  ? {
                      attachments: (
                        row.latest_attachments as NonNullable<RoomViewMessage['attachments']>
                      ).map((attachment) => ({
                        ...attachment,
                        url: attachment.url.startsWith('/')
                          ? `${this.publicOrigin}${attachment.url}`
                          : attachment.url,
                        ...(attachment.previewUrl?.startsWith('/')
                          ? { previewUrl: `${this.publicOrigin}${attachment.previewUrl}` }
                          : {}),
                        ...(attachment.thumbnailUrl?.startsWith('/')
                          ? { thumbnailUrl: `${this.publicOrigin}${attachment.thumbnailUrl}` }
                          : {}),
                      })),
                    }
                  : {}),
                author: identity(
                  {
                    id: row.latest_author_id,
                    kind: row.latest_author_kind,
                    name: row.latest_author_name,
                    handle: row.latest_author_handle,
                    avatar: row.latest_author_avatar,
                    face_id: row.latest_author_face,
                  },
                  this.publicOrigin,
                ),
                ...(row.latest_tags_viewer ? { mentionsViewer: true as const } : {}),
              },
            }
          : {}),
        ...(row.peer_id && row.peer_kind && row.peer_name
          ? {
              directMessage: {
                peer: identity(
                  {
                    id: row.peer_id,
                    kind: row.peer_kind,
                    name: row.peer_name,
                    handle: row.peer_handle,
                    avatar: row.peer_avatar,
                    face_id: row.peer_face,
                  },
                  this.publicOrigin,
                ),
                ...(this.directMessagePresence(row)
                  ? { presence: this.directMessagePresence(row)! }
                  : {}),
              },
            }
          : {}),
        unread: row.unread,
        ...(row.repository_key
          ? {
              repositoryName:
                row.repository_name ?? row.repository_key.split('/').at(-1) ?? row.repository_key,
            }
          : {}),
        ...(row.needs_you
          ? { agentState: 'needs-you' as const }
          : row.working
            ? { agentState: 'working' as const }
            : {}),
        ...(row.needs_you
          ? {
              attentionReason: {
                kind: 'approval' as const,
                ...(row.attention_actor_name ? { actor: row.attention_actor_name } : {}),
              },
            }
          : {}),
      })),
      viewer: await this.requireIdentity(viewerId),
      truncated: rooms.rows.length > 200,
      watchFilters: rooms.rows.length
        ? [{ kinds: [9, 9000, 9001, 9002, 9007, 9008], '#h': rooms.rows.map((row) => row.id) }]
        : [],
    };
  }

  private directMessagePresence(row: {
    peer_id: string | null;
    peer_kind: 'human' | 'agent' | null;
    peer_presence_body: Record<string, unknown> | null;
    peer_presence_updated_at: Date | null;
    peer_activity_at: Date | null;
  }): { status: 'online' | 'offline'; observedAt: number } | undefined {
    if (!row.peer_id || !row.peer_kind) return undefined;
    if (row.peer_kind === 'agent' && row.peer_presence_body && row.peer_presence_updated_at) {
      return {
        status:
          row.peer_presence_body.status === 'online' &&
          Date.now() - row.peer_presence_updated_at.getTime() < AGENT_REACHABLE_HORIZON_MS
            ? 'online'
            : 'offline',
        observedAt: Number(row.peer_presence_body.observedAt ?? unix(row.peer_presence_updated_at)),
      };
    }
    const connection = this.live?.humanPresence(row.peer_id);
    const activityAt = row.peer_activity_at ? unix(row.peer_activity_at) : undefined;
    const observedAt = Math.max(connection?.observedAt ?? 0, activityAt ?? 0);
    return observedAt
      ? { status: connection?.status === 'online' ? 'online' : 'offline', observedAt }
      : undefined;
  }

  async readRoom(roomId: string, viewerId: string): Promise<RoomView | null> {
    const readStartedAt = performance.now();
    const spans = new Map<string, number>();
    const measured = async <T>(operation: string, work: Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      try {
        return await work;
      } finally {
        spans.set(operation, performance.now() - startedAt);
      }
    };
    const topLevelRows = await measured('data', this.topLevelRoomRows(roomId, viewerId));
    const room =
      topLevelRows?.room ?? (await measured('access', this.roomAccess(roomId, viewerId)));
    if (!room) return null;
    if (!topLevelRows && !room.parent_id) {
      const cursor = await this.optionalEnrichment(
        'read-cursor',
        this.enrichmentDatabase.query<{
          read_cursor: NonNullable<RoomView['viewer']['readCursor']>;
        }>(`SELECT ${VIEWER_READ_CURSOR_SQL} read_cursor FROM rooms room WHERE room.id=$1`, [
          roomId,
          viewerId,
        ]),
      );
      room.read_cursor = cursor?.rows[0]?.read_cursor ?? null;
    }
    let allMembers: RoomViewMember[];
    let latestAgentTurns: RoomView['latestAgentTurns'];
    let messageResult: { messages: RoomViewMessage[]; toolRows: RoomViewMessage[] };
    if (topLevelRows) {
      const rows = topLevelRows;
      allMembers = this.projectMembers(rows.members, roomId);
      latestAgentTurns = this.projectAgentTurns(rows.turns);
      messageResult = this.projectRoomMessages(
        rows.transcript,
        rows.activity,
        [],
        latestAgentTurns,
        false,
        viewerId,
      );
    } else {
      // A corner also reads its parent briefing and lifecycle. Keep its
      // independent queries concurrent; the top-level live path above is the
      // high-frequency path whose remote round trips must stay bounded.
      const latestAgentTurnsPromise = this.latestAgentTurns(roomId);
      [allMembers, latestAgentTurns, messageResult] = await Promise.all([
        measured('members', this.members(room.workspace_id, roomId)),
        measured('turns', latestAgentTurnsPromise),
        measured('messages', this.roomMessages(roomId, latestAgentTurnsPromise, true, viewerId)),
      ]);
    }
    const members = allMembers.slice(0, ROOM_VIEW_MEMBER_LIMIT);
    const { messages, toolRows } = messageResult;
    const parent = room.parent_id
      ? (
          await measured(
            'parent',
            this.database.query<RoomRow>(`SELECT * FROM rooms WHERE id=$1`, [room.parent_id]),
          )
        ).rows[0]
      : undefined;
    const facts = room.parent_id
      ? (
          await measured(
            'facts',
            this.database.query<{
              plan: RoomView['cornerPlan'] | null;
              objective: string;
            }>(`SELECT plan,objective FROM corner_facts WHERE corner_id=$1`, [roomId]),
          )
        ).rows[0]
      : undefined;
    const boundApp = room.parent_id
      ? (
          await measured(
            'bound-app',
            this.database.query<{
              id: string;
              instance_id: string;
              manifest: unknown;
              developer_agent_id: string | null;
              developer_name: string | null;
              developer_handle: string | null;
            }>(
              `SELECT installation.id,binding.instance_id,installation.manifest,
                      installation.developer_agent_id,developer.name developer_name,
                      developer.handle developer_handle
               FROM corner_app_bindings binding
               JOIN corner_app_installations installation ON installation.id=binding.installation_id
               LEFT JOIN identities developer ON developer.id=installation.developer_agent_id
               WHERE binding.corner_id=$1`,
              [roomId],
            ),
          )
        ).rows[0]
      : undefined;
    const boundManifest = readCornerAppManifest(boundApp?.manifest);
    const cornerApps: CornerAppView[] = room.parent_id
      ? (
          await measured(
            'corner-apps',
            this.database.query<{
              definition: unknown;
              author_agent_id: string;
              author_name: string;
              author_handle: string | null;
              revision: number;
              updated_at: Date;
            }>(
              `SELECT app.definition,app.author_agent_id,author.name author_name,
                      author.handle author_handle,app.revision,app.updated_at
               FROM corner_apps app JOIN identities author ON author.id=app.author_agent_id
               WHERE app.corner_id=$1 ORDER BY app.updated_at DESC,app.slug`,
              [roomId],
            ),
          )
        ).rows.flatMap((row) => {
          const definition = readCornerAppDefinition(row.definition);
          return definition
            ? [
                {
                  ...definition,
                  authorId: row.author_agent_id,
                  authorName: row.author_name,
                  ...(row.author_handle ? { authorHandle: row.author_handle } : {}),
                  revision: row.revision,
                  updatedAt: unix(row.updated_at),
                },
              ]
            : [];
        })
      : [];
    if (boundManifest?.humanUi?.kind === 'native' && boundApp) {
      cornerApps.unshift({
        ...boundManifest.humanUi.definition,
        ...(boundApp.developer_agent_id ? { authorId: boundApp.developer_agent_id } : {}),
        authorName: boundApp.developer_name ?? boundManifest.developer,
        ...(boundApp.developer_handle ? { authorHandle: boundApp.developer_handle } : {}),
        revision: 1,
        updatedAt: unix(room.updated_at),
      });
    }
    const plan = facts?.plan;
    const paintedRoom = roomHeader(room, this.publicOrigin);
    const briefingRows: MessageRow[] = room.parent_id
      ? (
          await this.database.query<MessageRow>(
            `SELECT m.*,
               i.kind author_kind,i.name author_name,i.handle author_handle,
               i.avatar author_avatar,i.face_id author_face,
               ${reactionIdentitiesSql('m')} reaction_identities,
               '{}'::text[] tagged_ids
             FROM messages m JOIN identities i ON i.id=m.author_id
             WHERE m.room_id=$1 AND m.created_at<=$2
               AND (
                 NOT EXISTS(SELECT 1 FROM legacy_room_events all_legacy WHERE all_legacy.room_id=$1)
                 OR m.id IN(
                   SELECT page.id FROM legacy_room_events page
                   WHERE page.room_id=$1 AND page.kind=9 AND page.raw_page_candidate=true
                     AND page.created_at<=$2
                   ORDER BY page.created_at DESC,page.id ASC LIMIT 40
                 )
               )
             ORDER BY m.created_at DESC,m.id ASC LIMIT ${ROOM_VIEW_BRIEFING_LIMIT}`,
            [room.parent_id, room.created_at],
          )
        ).rows
      : [];
    await this.enrichMessageTags(briefingRows);
    const briefing = collapsePermissionCards(
      briefingRows.map((row) => projectedMessage(row, this.publicOrigin)).sort(messageOrder),
    );
    const attachmentFacts = await measured(
      'media',
      this.attachmentFacts(messages, toolRows, briefing),
    );
    const cornerLifecycle = room.parent_id
      ? await measured('lifecycle', this.cornerLifecycle(room.id))
      : undefined;
    const projectionStartedAt = performance.now();
    const view: RoomView = {
      room:
        room.parent_id && !paintedRoom.about && facts?.objective
          ? { ...paintedRoom, about: facts.objective }
          : paintedRoom,
      messages: decorateAttachments(messages, attachmentFacts),
      ...(toolRows.length ? { toolRows: decorateAttachments(toolRows, attachmentFacts) } : {}),
      members,
      latestAgentTurns,
      viewer: {
        ...(!room.parent_id && room.read_cursor ? { readCursor: room.read_cursor } : {}),
        identity: members.find((member) => member.identity.pubkey === viewerId)?.identity ?? {
          pubkey: viewerId,
          kind: 'human',
          name: `Person ${viewerId.slice(0, 8)}`,
        },
        role: room.viewer_role,
        permissions: {
          send:
            room.workspace_role !== 'spectator' &&
            !room.archived_at &&
            !room.direct_participants?.includes(SYSTEM_IDENTITY_ID),
          manage: room.workspace_role === 'owner' || room.workspace_role === 'admin',
        },
      },
      ...(room.direct_participants?.length === 2
        ? { directMessage: { participants: room.direct_participants as [string, string] } }
        : {}),
      ...(parent ? { parent: roomHeader(parent, this.publicOrigin) } : {}),
      briefing: decorateAttachments(briefing, attachmentFacts),
      ...(room.parent_id && plan ? { cornerPlan: plan } : {}),
      ...((parent ?? room).repository_key && (parent ?? room).repository_remote
        ? {
            repository: {
              key: (parent ?? room).repository_key!,
              name:
                (parent ?? room).repository_name ??
                (parent ?? room).repository_key!.split('/').at(-1) ??
                (parent ?? room).repository_key!,
              remote: (parent ?? room).repository_remote!,
              targetBranch: (parent ?? room).repository_target_branch,
              updatedAt: unix(
                (parent ?? room).repository_updated_at ?? (parent ?? room).updated_at,
              ),
              ...((parent ?? room).github_installation_id
                ? { githubInstallationId: Number((parent ?? room).github_installation_id) }
                : {}),
              githubEventsEnabled: (parent ?? room).github_events_enabled,
            },
          }
        : {}),
      repositoryResolution: (parent ?? room).repository_resolution,
      ...(cornerLifecycle ? { cornerLifecycle } : {}),
      ...(cornerApps.length ? { cornerApps } : {}),
      ...(boundApp && boundManifest
        ? {
            boundApp: {
              id: boundApp.id,
              instanceId: boundApp.instance_id,
              manifest: boundManifest,
            },
          }
        : {}),
      watchFilters: roomFilters(
        roomId,
        room.workspace_id,
        room.parent_id ? [room.parent_id] : [],
        allMembers,
      ),
    };
    spans.set('projection', performance.now() - projectionStartedAt);
    const durationMs = performance.now() - readStartedAt;
    if (durationMs >= SLOW_ROOM_READ_MS) {
      const pool = this.database.poolCounts?.();
      console.warn(
        '[slow-operation]',
        JSON.stringify({
          operation: 'phone.read_room',
          durationMs: Math.round(durationMs),
          spans: Object.fromEntries(
            [...spans].map(([operation, duration]) => [operation, Math.round(duration)]),
          ),
          ...(pool ? { pool: { total: pool.total, idle: pool.idle, waiting: pool.waiting } } : {}),
        }),
      );
    }
    return view;
  }

  async readHistory(
    roomId: string,
    viewerId: string,
    before?: { createdAt: number; id: string },
  ): Promise<RoomHistoryView | null> {
    if (!(await this.hasRoomAccess(roomId, viewerId))) return null;
    const rows = await this.messageRows(roomId, before, 31);
    const page = rows.slice(0, 30);
    await this.enrichMessageBookmarks(page, viewerId);
    const tail = page.at(-1);
    const messages = page
      .reverse()
      .map((row) => projectedMessage(row, this.publicOrigin, viewerId));
    return {
      roomId,
      messages: decorateAttachments(messages, await this.attachmentFacts(messages)),
      ...(rows.length > 30 && tail
        ? { nextBefore: { createdAt: unix(tail.created_at), id: tail.id } }
        : {}),
    };
  }

  /**
   * The Room's corner list. `archived` swaps the live set for the closed one:
   * the phone's corners screen reads the live list on open and asks for the
   * closed list only when a reader taps the archived footer, so a Room with
   * years of finished work never pays for it on the default read. The closed
   * list comes a page at a time, newest closure first; `archivedBefore` is the
   * `nextArchived` cursor of the page before.
   */
  async readCorners(
    roomId: string,
    viewerId: string,
    roomViewFamilyOrder = false,
    archived = false,
    archivedBefore?: ArchivedCornerCursor,
  ): Promise<CornerListView | null> {
    const parent = await this.database.query<
      RoomRow & {
        viewer_role: 'owner' | 'admin' | 'member' | 'spectator';
        workspace_role: 'owner' | 'admin' | 'member' | 'spectator';
      }
    >(
      `SELECT r.*,m.role viewer_role,workspace_member.role workspace_role
       FROM rooms r JOIN memberships m ON m.room_id=r.id
       JOIN memberships workspace_member ON workspace_member.workspace_id=r.workspace_id
         AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
         AND workspace_member.removed_at IS NULL
       WHERE r.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL`,
      [roomId, viewerId],
    );
    const room = parent.rows[0];
    if (!room) return null;
    const [fetched, viewerIdentity, appRows] = await Promise.all([
      this.cornerRows(roomId, viewerId, roomViewFamilyOrder, archived, archivedBefore),
      this.requireIdentity(viewerId),
      this.database.query<{ id: string; manifest: unknown }>(
        `SELECT id,manifest FROM corner_app_installations
         WHERE workspace_id=$1 ORDER BY connected_at DESC,id`,
        [room.workspace_id],
      ),
    ]);
    // The archived read asks for one row past the page; its presence is what
    // says another page exists.
    const more = archived && fetched.length > ARCHIVED_CORNER_PAGE;
    const rows = more ? fetched.slice(0, ARCHIVED_CORNER_PAGE) : fetched;
    const last = rows.at(-1);
    return {
      room: roomHeader(room, this.publicOrigin),
      corners: this.projectCorners(rows),
      ...(more && last?.archived_us ? { nextArchived: `${last.archived_us},${last.id}` } : {}),
      apps: appRows.rows.flatMap((row) => {
        const manifest = readCornerAppManifest(row.manifest);
        return manifest ? [{ id: row.id, manifest }] : [];
      }),
      viewer: {
        identity: viewerIdentity,
        role: room.viewer_role,
        permissions: {
          send: room.workspace_role !== 'spectator' && !room.archived_at,
          manage: room.workspace_role === 'owner' || room.workspace_role === 'admin',
        },
      },
      watchFilters: [],
    };
  }

  /**
   * A top-level Room's five paint inputs are independent, but production's
   * transaction pool can serialize five simultaneous requests behind one
   * another. Ask PostgreSQL for the same rows in one statement, then keep the
   * existing TypeScript projection as the sole DTO authority.
   */
  private async roomAccess(roomId: string, viewerId: string) {
    return (
      await this.database.query<
        RoomRow & {
          viewer_role: 'owner' | 'admin' | 'member' | 'spectator';
          workspace_role: 'owner' | 'admin' | 'member' | 'spectator';
          read_cursor: RoomView['viewer']['readCursor'] | null;
        }
      >(
        `SELECT room.*,membership.role viewer_role,workspace_member.role workspace_role,
           NULL::jsonb read_cursor
         FROM rooms room
         JOIN memberships membership ON membership.room_id=room.id
           AND membership.identity_id=$2 AND membership.removed_at IS NULL
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
           AND workspace_member.removed_at IS NULL
         WHERE room.id=$1`,
        [roomId, viewerId],
      )
    ).rows[0];
  }

  private async topLevelRoomRows(
    roomId: string,
    viewerId: string,
  ): Promise<TopLevelRoomReadRow | undefined> {
    const eligible = `m.id IN (
      (SELECT raw.id FROM legacy_room_events raw WHERE raw.room_id=$1 AND raw.kind=9
         AND raw.raw_page_candidate=true
       ORDER BY raw.created_at DESC,raw.id ASC LIMIT 180)
      UNION
      (SELECT conversation.id FROM legacy_room_events conversation
       WHERE conversation.room_id=$1 AND conversation.conversation_candidate=true
       ORDER BY conversation.created_at DESC,conversation.id ASC LIMIT 30)
      UNION
      (SELECT plan.id FROM legacy_room_events plan WHERE plan.room_id=$1 AND plan.kind=30078)
    )`;
    const row = (
      await this.database.query<TopLevelRoomReadRow>(
        `WITH authorized_room AS (
           SELECT room.*,membership.role viewer_role,
             workspace_member.role workspace_role,
             NULL::jsonb read_cursor
           FROM rooms room
           JOIN memberships membership ON membership.room_id=room.id
             AND membership.identity_id=$2 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           WHERE room.id=$1 AND room.parent_id IS NULL
         ), member_rows AS (
           SELECT i.id,i.kind,i.name,i.handle,i.avatar,i.face_id,
             membership.role,NULL::jsonb presence_body,
             NULL::timestamptz presence_updated_at
           FROM authorized_room room
           JOIN memberships membership ON membership.workspace_id=room.workspace_id
             AND membership.room_id=room.id
           JOIN identities i ON i.id=membership.identity_id
           WHERE membership.removed_at IS NULL AND i.hidden_from_roster=false
         ), turn_rows AS (
           SELECT DISTINCT ON(turn.agent_id)
             turn.request_id,turn.agent_id,turn.status,turn.started_at,turn.created_at,turn.generation_id,
             requester.id requested_by
           FROM authorized_room room
           JOIN agent_turns turn ON turn.room_id=room.id
           LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('turn')}
           LEFT JOIN identities requester ON requester.id=trigger.author_id AND requester.kind='human'
           ORDER BY turn.agent_id,turn.created_at DESC,turn.request_id DESC
         ), projected_turn_rows AS (
           SELECT agent_id,status,created_at FROM turn_rows
           ORDER BY date_trunc('second',created_at) DESC,agent_id ASC
           LIMIT ${ROOM_VIEW_AGENT_LIMIT}
         ), active_turn_rows AS (
           SELECT agent_id,created_at FROM projected_turn_rows WHERE status='working'
         ), transcript_rows AS (
           SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,
             i.avatar author_avatar,i.face_id author_face,
             ${reactionIdentitiesSql('m')} reaction_identities,
             EXISTS(SELECT 1 FROM message_bookmarks bookmark
               WHERE bookmark.identity_id=$2 AND bookmark.message_id=m.id) bookmarked,
             '{}'::text[] tagged_ids
           FROM authorized_room room
           JOIN messages m ON m.room_id=room.id
           JOIN identities i ON i.id=m.author_id
           WHERE (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
             AND ${hiddenWakeCardSql('m')}
             AND (NOT EXISTS(
               SELECT 1 FROM legacy_room_events any_legacy WHERE any_legacy.room_id=$1
             ) OR ${eligible})
           ORDER BY m.created_at DESC,m.id DESC LIMIT ${ROOM_VIEW_MESSAGE_LIMIT}
         ), activity_rows AS (
           SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,
             i.avatar author_avatar,i.face_id author_face,
             ${reactionIdentitiesSql('m')} reaction_identities,
             EXISTS(SELECT 1 FROM message_bookmarks bookmark
               WHERE bookmark.identity_id=$2 AND bookmark.message_id=m.id) bookmarked,
             '{}'::text[] tagged_ids
           FROM authorized_room room
           JOIN messages m ON m.room_id=room.id
           JOIN identities i ON i.id=m.author_id
           JOIN active_turn_rows turn ON turn.agent_id=m.author_id
             AND date_trunc('second',m.created_at)>=date_trunc('second',turn.created_at)
           WHERE m.presentation='activity' AND m.durable_fact IS NULL
             AND (NOT EXISTS(
               SELECT 1 FROM legacy_room_events any_legacy WHERE any_legacy.room_id=$1
             ) OR ${eligible})
           ORDER BY m.created_at DESC,m.id DESC
         )
         SELECT
           (to_jsonb(authorized_room) - 'github_installation_id')
             || jsonb_build_object(
               'github_installation_id',authorized_room.github_installation_id::text
             ) room,
           COALESCE((SELECT jsonb_agg(to_jsonb(member_rows)) FROM member_rows),'[]'::jsonb) members,
           COALESCE((SELECT jsonb_agg(to_jsonb(turn_rows)) FROM turn_rows),'[]'::jsonb) turns,
           COALESCE((SELECT jsonb_agg(to_jsonb(transcript_rows)
             ORDER BY transcript_rows.created_at DESC,transcript_rows.id DESC)
             FROM transcript_rows),'[]'::jsonb) transcript,
           COALESCE((SELECT jsonb_agg(to_jsonb(activity_rows)
             ORDER BY activity_rows.created_at DESC,activity_rows.id DESC)
             FROM activity_rows),'[]'::jsonb) activity
         FROM authorized_room`,
        [roomId, viewerId],
      )
    ).rows[0];
    if (!row) return undefined;
    const [cursor, presence, tags] = await Promise.all([
      this.optionalEnrichment(
        'read-cursor',
        this.enrichmentDatabase.query<{
          read_cursor: NonNullable<RoomView['viewer']['readCursor']>;
        }>(`SELECT ${VIEWER_READ_CURSOR_SQL} read_cursor FROM rooms room WHERE room.id=$1`, [
          roomId,
          viewerId,
        ]),
      ),
      this.optionalEnrichment(
        'presence',
        this.enrichmentDatabase.query<{
          id: string;
          presence_body: MemberRow['presence_body'];
          presence_updated_at: Date | null;
        }>(
          `SELECT member.identity_id id,presence.body presence_body,
             presence.updated_at presence_updated_at
           FROM memberships member
           LEFT JOIN LATERAL(
             SELECT body,updated_at FROM live_outputs
             WHERE agent_id=member.identity_id AND kind='presence'
             ORDER BY updated_at DESC LIMIT 1
           ) presence ON true
           WHERE member.room_id=$1 AND member.removed_at IS NULL`,
          [roomId],
        ),
      ),
      this.optionalEnrichment(
        'message-tags',
        this.enrichmentDatabase.query<{ id: string; tagged_ids: string[] }>(
          `SELECT m.id,${taggedIdentityIdsSql('m')} tagged_ids
           FROM messages m WHERE m.id=ANY($1::text[])`,
          [row.transcript.map((message) => message.id)],
        ),
      ),
    ]);
    row.room.read_cursor = cursor?.rows[0]?.read_cursor ?? null;
    const presenceByMember = new Map(presence?.rows.map((item) => [item.id, item]) ?? []);
    for (const member of row.members) {
      const item = presenceByMember.get(member.id);
      member.presence_body = item?.presence_body ?? null;
      member.presence_updated_at = item?.presence_updated_at ?? null;
    }
    const tagsByMessage = new Map(tags?.rows.map((item) => [item.id, item.tagged_ids]) ?? []);
    for (const message of row.transcript) message.tagged_ids = tagsByMessage.get(message.id) ?? [];
    reviveDates(row.room, ['archived_at', 'repository_updated_at', 'created_at', 'updated_at']);
    for (const member of row.members) reviveDates(member, ['presence_updated_at']);
    for (const turn of row.turns) reviveDates(turn, ['started_at', 'created_at']);
    for (const message of [...row.transcript, ...row.activity])
      reviveDates(message, ['created_at']);
    return row;
  }

  private async cornerRows(
    roomId: string,
    viewerId: string,
    roomViewFamilyOrder = false,
    archived = false,
    archivedBefore?: ArchivedCornerCursor,
  ): Promise<CornerRow[]> {
    // The archived list is ordered by when work CLOSED, not when it opened: a
    // corner opened first can close last, and a reader looking for what just
    // finished expects it at the top.
    const order = archived
      ? 'ORDER BY c.archived_at DESC,c.id DESC'
      : roomViewFamilyOrder
        ? ''
        : 'ORDER BY c.created_at DESC,c.id DESC';
    // Keyset paging on the same (archived_at, id) order, compared in exact
    // microseconds, so no row is skipped or repeated between pages.
    const archivedMicros = '(extract(epoch FROM c.archived_at)*1000000)::bigint';
    const keyset =
      archived && archivedBefore ? `AND (${archivedMicros},c.id) < ($3::bigint,$4::uuid)` : '';
    const limit = archived ? `LIMIT ${ARCHIVED_CORNER_PAGE + 1}` : '';
    return (
      await this.database.query<CornerRow>(
        `
      SELECT c.*,f.lifecycle,f.objective,lm.id latest_id,lm.text latest_text,lm.created_at latest_created_at,lm.author_id latest_author_id,
        initiator.id initiator_id,initiator.name initiator_name,
        initiator.handle initiator_handle,initiator.avatar initiator_avatar,
        initiator.face_id initiator_face,
        li.kind latest_author_kind,li.name latest_author_name,
        $2=ANY(${taggedIdentityIdsSql('lm')}) latest_tags_viewer,agent.identity_id agent_id,
        agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
        turn.status latest_turn_status,turn.created_at latest_turn_created_at,
        app_binding.installation_id app_installation_id,
        app_binding.instance_id app_instance_id,app_installation.manifest app_manifest,
        ${archivedMicros}::text archived_us
      FROM rooms c LEFT JOIN corner_facts f ON f.corner_id=c.id
      LEFT JOIN identities initiator
        ON initiator.id=f.commissioned_by AND initiator.kind='human'
      LEFT JOIN LATERAL (SELECT * FROM messages WHERE room_id=c.id AND presentation IN ('message','system') ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN LATERAL (
        SELECT i.id identity_id,
          i.name,i.handle,i.avatar
        FROM identities i
        LEFT JOIN memberships member ON member.room_id=c.id AND member.identity_id=i.id
          AND member.removed_at IS NULL
        WHERE i.id=f.owner_agent_id
          AND i.kind='agent' LIMIT 1
      ) agent ON true
      LEFT JOIN LATERAL (
        SELECT status,created_at FROM agent_turns WHERE room_id=c.id
        ORDER BY created_at DESC LIMIT 1
      ) turn ON true
      LEFT JOIN corner_app_bindings app_binding ON app_binding.corner_id=c.id
      LEFT JOIN corner_app_installations app_installation ON app_installation.id=app_binding.installation_id
      WHERE c.parent_id=$1 AND c.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} AND EXISTS(
        SELECT 1 FROM memberships viewer
        WHERE viewer.room_id=c.id AND viewer.identity_id=$2 AND viewer.removed_at IS NULL
      ) ${keyset} ${order} ${limit}`,
        keyset
          ? [roomId, viewerId, archivedBefore!.micros, archivedBefore!.id]
          : [roomId, viewerId],
      )
    ).rows;
  }

  private projectCorners(rows: readonly CornerRow[]): CornerListView['corners'] {
    return rows.map((corner) => {
      const lifecycle = corner.lifecycle ?? {
        lifecycle: corner.archived_at ? 'done' : 'unknown',
        checks: 'unknown',
      };
      const hasLiveWorkingTurn = corner.latest_turn_status === 'working';
      const derived = deriveCornerState({
        archived: Boolean(corner.archived_at),
        turnRunning: hasLiveWorkingTurn,
        lifecycle,
      });
      const header = roomHeader(corner, this.publicOrigin);
      const about = header.about ?? (corner.objective?.trim() || undefined);
      const appManifest = readCornerAppManifest(corner.app_manifest);
      return {
        corner: about ? { ...header, about } : header,
        lifecycle,
        ...derived,
        stateAt:
          hasLiveWorkingTurn && corner.latest_turn_created_at
            ? unix(corner.latest_turn_created_at)
            : unix(corner.updated_at),
        // `updated_at` moves with any later write, so the closure stamp reads
        // the archive time itself rather than the row's last touch.
        ...(corner.archived_at ? { closedAt: unix(corner.archived_at) } : {}),
        // A corner awaits the viewer when it is parked on a person and its
        // latest message tags them.
        ...(corner.latest_tags_viewer && (derived.state === 'waiting' || derived.state === 'review')
          ? { awaitsViewer: true as const }
          : {}),
        ...(corner.initiator_id && corner.initiator_name
          ? {
              initiator: {
                pubkey: corner.initiator_id,
                kind: 'human' as const,
                name: corner.initiator_name,
                ...(corner.initiator_handle ? { handle: corner.initiator_handle } : {}),
                ...(corner.initiator_avatar
                  ? { avatar: assetUrl(corner.initiator_avatar, this.publicOrigin) }
                  : {}),
                ...(corner.initiator_face ? { face: corner.initiator_face } : {}),
              },
            }
          : {}),
        ...(corner.agent_id && corner.agent_name
          ? {
              agent: {
                pubkey: corner.agent_id,
                kind: 'agent' as const,
                name: corner.agent_name,
                ...(corner.agent_handle ? { handle: corner.agent_handle } : {}),
                ...(corner.agent_avatar
                  ? { avatar: assetUrl(corner.agent_avatar, this.publicOrigin) }
                  : {}),
              },
            }
          : {}),
        ...(corner.app_installation_id && corner.app_instance_id && appManifest
          ? {
              app: {
                id: corner.app_installation_id,
                instanceId: corner.app_instance_id,
                manifest: appManifest,
              },
            }
          : {}),
        ...(corner.latest_id &&
        corner.latest_created_at &&
        corner.latest_author_id &&
        corner.latest_author_kind &&
        corner.latest_author_name
          ? {
              latestMessage: {
                id: corner.latest_id,
                text: corner.latest_text ?? '',
                createdAt: unix(corner.latest_created_at),
                author: {
                  pubkey: corner.latest_author_id,
                  kind: corner.latest_author_kind,
                  name: corner.latest_author_name,
                },
              },
            }
          : {}),
      };
    });
  }

  async readAgent(
    workspaceId: string,
    agentId: string,
    viewerId: string,
    workCursor?: string,
  ): Promise<AgentDetailView | null> {
    const viewer = await this.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [workspaceId, viewerId],
    );
    if (!viewer.rowCount) return null;
    const member = (await this.members(workspaceId, null, agentId)).find(
      (entry) => entry.identity.pubkey === agentId,
    );
    if (!member || member.identity.kind !== 'agent') return null;
    const config = (
      await this.database.query<{
        soul: AgentDetailView['soul'] | null;
        model_catalog: AgentDetailView['catalog'];
        commands: AgentDetailView['commands'];
        selected_model: string | null;
        selected_effort: string | null;
        model_unavailable: 'model' | 'effort' | 'selection' | null;
        yolo_mode: boolean;
        yolo_forced_off: boolean;
        yolo_set_by_name: string | null;
        yolo_set_at: Date | null;
        avatar_generation_id: string | null;
        avatar_generation_pending: boolean;
        can_change_yolo: boolean;
        can_manage_grants: boolean;
        access_policy: unknown;
        owner_id: string | null;
        owner_name: string | null;
        owner_handle: string | null;
      }>(
        `SELECT a.soul,a.model_catalog,a.commands,a.selected_model,a.selected_effort,a.model_unavailable,
                (SELECT id::text FROM agent_avatars WHERE agent_id=a.agent_id) avatar_generation_id,
                EXISTS(SELECT 1 FROM agent_commands c WHERE c.agent_id=a.agent_id AND c.avatar_job AND c.state IN ('pending','claimed')) avatar_generation_pending,
                CASE WHEN workspace.visibility='public' THEN false ELSE a.yolo_mode END yolo_mode,
                workspace.visibility='public' yolo_forced_off,a.yolo_set_at,
                setter.name yolo_set_by_name,a.access_policy,a.owner_id,
                owner.name owner_name,owner.handle owner_handle,
                a.owner_id=$3 can_change_yolo,
                (a.owner_id=$3 OR viewer_membership.role IN ('owner','admin')) can_manage_grants
         FROM agents a
         JOIN memberships agent_membership ON agent_membership.identity_id=a.agent_id
           AND agent_membership.workspace_id=$2 AND agent_membership.room_id IS NULL
           AND agent_membership.removed_at IS NULL
         JOIN workspaces workspace ON workspace.id=agent_membership.workspace_id
         JOIN memberships viewer_membership ON viewer_membership.workspace_id=$2
           AND viewer_membership.room_id IS NULL AND viewer_membership.identity_id=$3
           AND viewer_membership.removed_at IS NULL
         LEFT JOIN identities setter ON setter.id=a.yolo_set_by
         LEFT JOIN identities owner ON owner.id=a.owner_id
         WHERE a.agent_id=$1`,
        [agentId, workspaceId, viewerId],
      )
    ).rows[0];
    let cursor: [string, string] | null = null;
    if (workCursor) {
      try {
        const value: unknown = JSON.parse(workCursor);
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !value.every((part) => typeof part === 'string' && part.length <= 2048)
        )
          throw new Error('invalid cursor');
        cursor = value as [string, string];
      } catch {
        throw new Error('invalid recent work cursor');
      }
    }
    const recentWork = await this.database.query<{ title: string; url: string; merged_at: string }>(
      `SELECT max(f.lifecycle->'pr'->>'title') title, f.lifecycle->'pr'->>'url' url,
              max(f.lifecycle->'pr'->>'mergedAt') merged_at
       FROM corner_facts f JOIN rooms r ON r.id=f.corner_id
       WHERE r.workspace_id=$1 AND f.owner_agent_id=$2
         AND NULLIF(f.lifecycle->'pr'->>'mergedAt','') IS NOT NULL
         AND NULLIF(f.lifecycle->'pr'->>'title','') IS NOT NULL
         AND f.lifecycle->'pr'->>'url' ~ '^https://github[.]com/[^/]+/[^/]+/pull/[0-9]+$'
         AND EXISTS (SELECT 1 FROM memberships m WHERE m.room_id=r.id
           AND m.identity_id=$3 AND m.removed_at IS NULL)
       GROUP BY f.lifecycle->'pr'->>'url'
       HAVING $4::text IS NULL OR (max(f.lifecycle->'pr'->>'mergedAt'), f.lifecycle->'pr'->>'url') < ($4,$5)
       ORDER BY merged_at DESC, url DESC LIMIT 6`,
      [workspaceId, agentId, viewerId, cursor?.[0] ?? null, cursor?.[1] ?? null],
    );
    const workPage = recentWork.rows.slice(0, 5);
    const lastWork = workPage.at(-1);
    return {
      workspaceId,
      ...(config?.avatar_generation_id ? { avatarGenerationId: config.avatar_generation_id } : {}),
      avatarGenerationPending: config?.avatar_generation_pending ?? false,
      recentWork: workPage.map(({ title, url }) => ({ title, url })),
      ...(recentWork.rows.length > 5 && lastWork
        ? { recentWorkCursor: JSON.stringify([lastWork.merged_at, lastWork.url]) }
        : {}),
      agent: member,
      ...(config?.soul
        ? {
            soul: {
              ...config.soul,
              // Souls stored before the avatar-seed rule (e.g. connect-wizard
              // souls) default the seed to the agent pubkey, matching display.
              avatarSeed: config.soul.avatarSeed || agentId,
            },
          }
        : {}),
      // The soul this agent's animal carries: what an edited soul restores to.
      // Derived from the face it wears, so name, avatar and soul stay one animal.
      seededSoul: FACE_SOULS[resolveFace(member.identity.face, agentId)],
      ...(config?.owner_id && config.owner_name
        ? {
            owner: {
              pubkey: config.owner_id,
              kind: 'human' as const,
              name: config.owner_name,
              ...(config.owner_handle ? { handle: config.owner_handle } : {}),
            },
          }
        : {}),
      catalog: config?.model_catalog ?? [],
      commands: config?.commands ?? [],
      ...(config?.model_unavailable ? { modelUnavailable: config.model_unavailable } : {}),
      ...(config?.selected_model || config?.selected_effort
        ? {
            selected: {
              ...(config.selected_model ? { model: config.selected_model } : {}),
              ...(config.selected_effort ? { effort: config.selected_effort } : {}),
            },
          }
        : {}),
      yolo: {
        enabled: config?.yolo_mode ?? false,
        ...(config?.yolo_forced_off ? { forcedOff: true } : {}),
        ...(config?.yolo_set_by_name ? { setBy: { name: config.yolo_set_by_name } } : {}),
        ...(config?.yolo_set_at ? { setAt: unix(config.yolo_set_at) } : {}),
        canChange: config?.can_change_yolo ?? false,
      },
      // Who may address this agent. Read from the server row, never from what a
      // helper was paired with, so the row and the running behaviour are one fact.
      access: {
        policy: parseAgentAccessPolicy(config?.access_policy).type,
        ...(config?.owner_id && config.owner_name
          ? {
              owner: {
                id: config.owner_id,
                name: config.owner_name,
                ...(config.owner_handle ? { handle: config.owner_handle } : {}),
              },
            }
          : {}),
        canChange: config?.can_change_yolo ?? false,
      },
      grants: (await this.agentGrants(workspaceId, agentId)).filter(
        (grant) => grant.kind === 'repository' || config?.owner_id === viewerId,
      ),
      // Grant decisions retain their separate owner-or-Workspace-manager axis.
      canManageGrants: config?.can_manage_grants ?? false,
      watchFilters: [],
    };
  }
  /** The grant store as the profile lists it: every non-pending grant, newest first. */
  private async agentGrants(workspaceId: string, agentId: string): Promise<AgentGrantView[]> {
    const rows = await this.database.query<{
      id: string;
      kind: AgentGrantView['kind'];
      target: string;
      reason: string;
      status: AgentGrantStatus;
      room_id: string;
      auto: boolean;
      created_at: Date;
      decided_at: Date | null;
      expires_at: Date | null;
      requester: IdentityRow;
      decider: IdentityRow | null;
      script: unknown;
    }>(
      `SELECT g.id,g.kind,g.target,g.reason,g.status,g.room_id,g.auto,g.created_at,g.decided_at,g.expires_at,
              g.script,to_jsonb(requester) requester,to_jsonb(decider) decider
       FROM agent_grants g
       JOIN identities requester ON requester.id=g.requested_by
       LEFT JOIN identities decider ON decider.id=g.decided_by
       WHERE g.agent_id=$1 AND g.workspace_id=$2 AND g.status<>'pending'
       ORDER BY g.created_at DESC,g.id`,
      [agentId, workspaceId],
    );
    return rows.rows.map((row) => ({
      grantId: row.id,
      kind: row.kind,
      target: row.target,
      reason: row.reason,
      status: row.status,
      requestedBy: identity(row.requester, this.publicOrigin),
      ...(row.decider ? { decidedBy: identity(row.decider, this.publicOrigin) } : {}),
      roomId: row.room_id,
      createdAt: unix(row.created_at),
      ...(row.decided_at ? { decidedAt: unix(row.decided_at) } : {}),
      ...(row.expires_at ? { expiresAt: unix(row.expires_at) } : {}),
      auto: row.auto,
      // C94: the profile shows what the interpreter approval was bound to.
      ...(isCommandGrantScript(row.script) ? { script: row.script } : {}),
    }));
  }

  async readInvite(rawToken: string, viewerId: string): Promise<InviteView | null> {
    if (!isCommunityInviteToken(rawToken)) return null;
    const result = await this.database.query<{
      name: string;
      avatar: string | null;
      expires_at: Date;
      workspace_id: string;
      already_joined: boolean;
    }>(
      `SELECT w.name,w.avatar,i.expires_at,i.workspace_id,
         EXISTS(SELECT 1 FROM memberships joined
           WHERE joined.workspace_id=i.workspace_id AND joined.room_id IS NULL
             AND joined.identity_id=$2 AND joined.removed_at IS NULL) already_joined
       FROM invites i
       JOIN workspaces w ON w.id=i.workspace_id
       JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
         AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
       WHERE i.token_hash=$1 AND i.expires_at>now()`,
      [hash(rawToken), viewerId],
    );
    const row = result.rows[0];
    return row
      ? {
          name: row.name,
          ...(row.avatar ? { avatar: assetUrl(row.avatar, this.publicOrigin) } : {}),
          expiresAt: unix(row.expires_at),
          ...(row.already_joined ? { joinedWorkspaceId: row.workspace_id } : {}),
        }
      : null;
  }

  async claimAgentPairing(code: string, agentId: string): Promise<AgentPairingClaimView | null> {
    return this.database.transaction(async (database) => {
      const result = await database.query<{
        workspace_id: string;
        created_by: string;
        claimed_by: string | null;
      }>(
        `SELECT workspace_id,created_by,claimed_by FROM agent_pairing_codes WHERE code_hash=$1 AND expires_at>now() FOR UPDATE`,
        [hash(code)],
      );
      const pairing = result.rows[0];
      if (!pairing || (pairing.claimed_by && pairing.claimed_by !== agentId)) return null;
      const existingMembership = await database.query(
        `SELECT 1 FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
        [pairing.workspace_id, agentId],
      );
      if (!existingMembership.rowCount) {
        const lockedWorkspaces = lockIdentityHandleWorkspaces(database, agentId, [
          pairing.workspace_id,
        ]);
        await lockedWorkspaces;
        const agent = (
          await database.query<{ name: string }>(
            `SELECT name FROM identities WHERE id=$1 AND kind='agent'`,
            [agentId],
          )
        ).rows[0];
        if (!agent) return null;
        const handle = await this.availableAgentHandle(
          database,
          pairing.workspace_id,
          agentId,
          agent.name,
          lockedWorkspaces,
        );
        await database.query(`UPDATE identities SET handle=$2,updated_at=now() WHERE id=$1`, [
          agentId,
          handle,
        ]);
      }
      const joined = !pairing.claimed_by;
      if (joined)
        await database.query(
          `UPDATE agent_pairing_codes SET claimed_by=$2,claimed_at=now() WHERE code_hash=$1`,
          [hash(code), agentId],
        );
      const workspaceMembership = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
         VALUES ($1,NULL,$2,'member',$3) ON CONFLICT DO NOTHING`,
        [pairing.workspace_id, agentId, pairing.created_by],
      );
      const rooms = await joinRooms(database, {
        workspaceId: pairing.workspace_id,
        identityId: agentId,
        invitedById: pairing.created_by,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: workspaceMembership.rowCount > 0,
      });
      return {
        workspaceId: pairing.workspace_id,
        pairedBy: pairing.created_by,
        joined,
        attachedRoomIds: rooms.roomIds,
      };
    });
  }

  /**
   * The animals, names and souls the Workspace is already using. Only the
   * server knows the roster, so seeded-identity assignment happens here — and
   * always inside the caller's transaction, under the Workspace row lock, so
   * two agents connecting at once cannot both take the fox.
   */
  private async wornSeededIdentity(
    database: SqlDatabase,
    workspaceId: string,
    exceptIdentityId: string,
  ): Promise<{ faces: string[]; names: string[] }> {
    const rows = await database.query<{
      id: string;
      name: string;
      face_id: string | null;
    }>(
      `SELECT i.id,i.name,i.face_id
       FROM memberships m
       JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND i.hidden_from_roster=false AND i.id<>$2`,
      [workspaceId, exceptIdentityId],
    );
    return {
      // A member with no chosen face still wears one: the hash default every
      // tile draws. Both count as taken, people and agents alike.
      faces: rows.rows.map((row) => resolveFace(row.face_id, row.id)),
      names: rows.rows.map((row) => row.name),
    };
  }

  private async availableAgentHandle(
    database: SqlDatabase,
    workspaceId: string,
    exceptIdentityId: string,
    name: string,
    lockedWorkspaces = lockIdentityHandleWorkspaces(database, exceptIdentityId, [workspaceId]),
  ): Promise<string> {
    const workspaceIds = await lockedWorkspaces;
    const rows = await database.query<{ handle: string }>(
      `SELECT identity.handle
       FROM memberships membership
       JOIN identities identity ON identity.id=membership.identity_id
       WHERE membership.workspace_id=ANY($1::uuid[]) AND membership.room_id IS NULL
         AND membership.removed_at IS NULL AND identity.hidden_from_roster=false
         AND identity.id<>$2 AND identity.handle IS NOT NULL`,
      [workspaceIds, exceptIdentityId],
    );
    return uniqueAgentHandle(
      name,
      rows.rows.map((row) => row.handle),
    );
  }

  async claimAgentConnectPairing(input: {
    code: string;
    agentPubkey: string;
    model: string;
    /**
     * The reasoning effort the connect wizard asked for. Absent from a harness
     * with no effort axis, and from any CLI built before the wizard asked; both
     * leave the agent on whatever effort its harness starts at.
     */
    effort?: string;
    avatarSeed?: string;
    /** Server event kinds this agent reacts to; only spent on the immediate, legacy join below. */
    eventSubscriptions?: readonly string[];
    /**
     * The signal a two-step CLI sends: it will call `finishAgentConnectPairing`
     * itself once its rename decision settles, so the claim must not join Rooms
     * or announce yet. A CLI built before that two-step flow existed never
     * sends this and never calls finish, so its absence keeps the original,
     * immediate join — compatibility for every already-installed helper.
     */
    deferJoin?: boolean;
  }): Promise<
    | {
        status: 'claimed';
        workspaceId: string;
        workspaceName: string;
        pairedBy: string;
        agentName: string;
        soul: string;
        face: string;
        workspaceJoined: boolean;
      }
    | { status: 'not_found' | 'expired' | 'already_claimed' }
  >;
  async claimAgentConnectPairing(
    input: {
      code: string;
      agentPubkey: string;
      model: string;
      effort?: string;
      avatarSeed?: string;
      eventSubscriptions?: readonly string[];
      deferJoin?: boolean;
      /** Stable machine identifier for the host running this agent. */
      machineId?: string;
      /** Human-readable machine name (e.g. hostname). */
      machineName?: string;
    },
    createDaemonExchange: (
      agentId: string,
      database: SqlDatabase,
    ) => Promise<{ exchangeToken: string }>,
  ): Promise<
    | {
        status: 'claimed';
        workspaceId: string;
        workspaceName: string;
        pairedBy: string;
        agentName: string;
        soul: string;
        face: string;
        workspaceJoined: boolean;
        daemonExchangeToken: string;
      }
    | { status: 'not_found' | 'expired' | 'already_claimed' }
  >;
  async claimAgentConnectPairing(
    input: {
      code: string;
      agentPubkey: string;
      model: string;
      effort?: string;
      avatarSeed?: string;
      eventSubscriptions?: readonly string[];
      deferJoin?: boolean;
      machineId?: string;
      machineName?: string;
    },
    createDaemonExchange?: (
      agentId: string,
      database: SqlDatabase,
    ) => Promise<{ exchangeToken: string }>,
  ): Promise<
    | {
        status: 'claimed';
        workspaceId: string;
        workspaceName: string;
        pairedBy: string;
        agentName: string;
        soul: string;
        face: string;
        workspaceJoined: boolean;
        daemonExchangeToken?: string;
      }
    | { status: 'not_found' | 'expired' | 'already_claimed' }
  > {
    return this.database.transaction(async (database) => {
      const result = await database.query<{
        workspace_id: string;
        workspace_name: string;
        created_by: string;
        claimed_by: string | null;
        expires_at: Date;
      }>(
        `SELECT pairing.workspace_id,workspace.name AS workspace_name,pairing.created_by,
                pairing.claimed_by,pairing.expires_at
         FROM agent_pairing_codes pairing
         JOIN workspaces workspace ON workspace.id=pairing.workspace_id
         WHERE pairing.code_hash=$1
         FOR UPDATE OF pairing`,
        [hash(input.code)],
      );
      const pairing = result.rows[0];
      if (!pairing) return { status: 'not_found' };
      if (pairing.expires_at.getTime() <= Date.now()) return { status: 'expired' };
      if (pairing.claimed_by) return { status: 'already_claimed' };

      const lockedWorkspaces = lockIdentityHandleWorkspaces(database, input.agentPubkey, [
        pairing.workspace_id,
      ]);
      await lockedWorkspaces;
      const worn = await this.wornSeededIdentity(database, pairing.workspace_id, input.agentPubkey);
      const seeded = assignSeededAgentIdentity({
        seed: input.agentPubkey,
        takenFaces: worn.faces,
        takenNames: worn.names,
      });
      const handle = await this.availableAgentHandle(
        database,
        pairing.workspace_id,
        input.agentPubkey,
        seeded.name,
        lockedWorkspaces,
      );

      // Pairing a key whose agent was removed starts it over rather than
      // resurrecting it: the seeded name, animal and soul are assigned afresh
      // under the same dedup, and every retired setting is written back to its
      // freshly-paired value. A key that belongs to a person is never
      // overwritten into an agent.
      const identityRow = await database.query(
        `INSERT INTO identities(id,kind,name,handle,face_id) VALUES($1,'agent',$2,$3,$4)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,handle=EXCLUDED.handle,face_id=EXCLUDED.face_id,
           avatar=NULL,hidden_from_roster=false,updated_at=now()
         WHERE identities.kind='agent'
         RETURNING id`,
        [input.agentPubkey, seeded.name, handle, seeded.face],
      );
      if (!identityRow.rowCount) throw new Error('pairing key belongs to a person');
      await database.query(
        `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,machine_id,machine_name)
         VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)
         ON CONFLICT(agent_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,soul=EXCLUDED.soul,
           selected_model=EXCLUDED.selected_model,selected_effort=EXCLUDED.selected_effort,
           model_catalog='[]'::jsonb,model_unavailable=NULL,commands='[]'::jsonb,
           schedule_ids='[]'::jsonb,
           yolo_mode=false,yolo_set_by=NULL,yolo_set_at=NULL,
           access_policy='{"type":"everyone"}'::jsonb,machine_id=EXCLUDED.machine_id,
           machine_name=EXCLUDED.machine_name,updated_at=now()`,
        [
          input.agentPubkey,
          pairing.created_by,
          JSON.stringify({
            name: seeded.name,
            instructions: seeded.soul,
            avatarSeed: input.avatarSeed || input.agentPubkey,
          }),
          input.model,
          input.effort || null,
          input.machineId || null,
          input.machineName || null,
        ],
      );
      await database.query(
        `UPDATE agent_pairing_codes SET claimed_by=$2,claimed_at=now() WHERE code_hash=$1`,
        [hash(input.code), input.agentPubkey],
      );
      const workspaceMembership = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
         VALUES ($1,NULL,$2,'member',$3)
         ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET role='member',removed_at=NULL,joined_at=now(),invited_by=EXCLUDED.invited_by
           WHERE memberships.removed_at IS NOT NULL
         RETURNING id`,
        [pairing.workspace_id, input.agentPubkey, pairing.created_by],
      );
      // A deferring CLI joins Rooms itself through `finishAgentConnectPairing`
      // once its rename decision settles — a system line is a fact written
      // once, never rewritten by a later rename, so it must not be written
      // under the seeded name only to go stale the moment the person renames.
      // A CLI that never asked to defer (every already-installed helper) gets
      // the original, immediate join right here instead.
      if (!input.deferJoin) {
        const joined = await joinRooms(database, {
          workspaceId: pairing.workspace_id,
          identityId: input.agentPubkey,
          invitedById: pairing.created_by,
          rooms: { type: 'all-live-top-level' },
          workspaceJoined: workspaceMembership.rowCount > 0,
        });
        const subscriptions = [...new Set(input.eventSubscriptions ?? [])].filter(
          isServerEventKind,
        );
        if (subscriptions.length && joined.roomIds.length) {
          await database.query(
            `UPDATE memberships SET event_subscriptions=$3::jsonb
             WHERE identity_id=$1 AND room_id=ANY($2::uuid[])`,
            [input.agentPubkey, joined.roomIds, JSON.stringify(subscriptions)],
          );
        }
      }
      const machineId = input.machineId || input.agentPubkey;
      const squireOnMachine = await database.query(
        `SELECT 1 FROM workspace_connectors
         WHERE workspace_id=$1 AND owner_identity_id=$2 AND connector_type='trusty-squire'
           AND machine_id=$3 AND status IN ('installing','connected')`,
        [pairing.workspace_id, pairing.created_by, machineId],
      );
      if (squireOnMachine.rowCount) {
        await grantSquireToOwnerMachineAgents(database, {
          workspaceId: pairing.workspace_id,
          ownerIdentityId: pairing.created_by,
          machineId,
          agentId: input.agentPubkey,
        });
      }
      const exchange = createDaemonExchange
        ? await createDaemonExchange(input.agentPubkey, database)
        : undefined;
      return {
        status: 'claimed',
        workspaceId: pairing.workspace_id,
        workspaceName: pairing.workspace_name,
        pairedBy: pairing.created_by,
        agentName: seeded.name,
        soul: seeded.soul,
        face: seeded.face,
        workspaceJoined: workspaceMembership.rowCount > 0,
        ...(exchange ? { daemonExchangeToken: exchange.exchangeToken } : {}),
      };
    });
  }

  /**
   * The one rename the terminal may make: right after `usebeeline connect`
   * prints the seeded identity, before the person has ever opened the app.
   * Authority is the pairing code itself — typed out of the app by someone who
   * could already add an agent — and it expires with the claim, so the CLI
   * never holds standing authority over the name. Every later rename goes
   * through the app's owner-gated agent page.
   */
  async renameConnectedAgent(input: {
    code: string;
    name: string;
  }): Promise<{ status: 'renamed'; agentName: string } | { status: 'not_found' | 'expired' }> {
    const name = normalizeAgentName(input.name);
    return this.database.transaction(async (database) => {
      const pairing = (
        await database.query<{
          claimed_by: string | null;
          claimed_at: Date | null;
          workspace_id: string;
        }>(
          `SELECT claimed_by,claimed_at,workspace_id FROM agent_pairing_codes WHERE code_hash=$1 FOR UPDATE`,
          [hash(input.code)],
        )
      ).rows[0];
      if (!pairing?.claimed_by || !pairing.claimed_at) return { status: 'not_found' };
      if (Date.now() - pairing.claimed_at.getTime() > CONNECT_RENAME_WINDOW_MS)
        return { status: 'expired' };
      const handle = await this.availableAgentHandle(
        database,
        pairing.workspace_id,
        pairing.claimed_by,
        name,
      );
      await database.query(`UPDATE identities SET name=$2,handle=$3,updated_at=now() WHERE id=$1`, [
        pairing.claimed_by,
        name,
        handle,
      ]);
      await database.query(
        `UPDATE agents SET soul=jsonb_set(soul,'{name}',to_jsonb($2::text)),updated_at=now()
         WHERE agent_id=$1 AND soul IS NOT NULL`,
        [pairing.claimed_by, name],
      );
      return { status: 'renamed', agentName: name };
    });
  }

  /**
   * The last step of `usebeeline connect`: room membership and the "joined"
   * announcement, run once the wizard's one rename window has closed (kept or
   * renamed). `renameConnectedAgent` may have already retitled the identity by
   * the time this runs, so `joinRooms` reads its final name straight off
   * `identities` — the same order a human already follows, since GitHub
   * sign-in seals a person's name before `landInWelcomeWorkspace` ever runs.
   */
  async finishAgentConnectPairing(input: {
    code: string;
    workspaceJoined: boolean;
    eventSubscriptions?: readonly string[];
  }): Promise<{ status: 'finished' } | { status: 'not_found' | 'expired' }> {
    return this.database.transaction(async (database) => {
      const pairing = (
        await database.query<{
          claimed_by: string | null;
          claimed_at: Date | null;
          created_by: string;
          workspace_id: string;
        }>(
          `SELECT claimed_by,claimed_at,created_by,workspace_id
           FROM agent_pairing_codes WHERE code_hash=$1 FOR UPDATE`,
          [hash(input.code)],
        )
      ).rows[0];
      if (!pairing?.claimed_by || !pairing.claimed_at) return { status: 'not_found' };
      if (Date.now() - pairing.claimed_at.getTime() > CONNECT_RENAME_WINDOW_MS)
        return { status: 'expired' };
      const joined = await joinRooms(database, {
        workspaceId: pairing.workspace_id,
        identityId: pairing.claimed_by,
        invitedById: pairing.created_by,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: input.workspaceJoined,
      });
      // What this agent reacts to, in the Rooms it just joined. A subscription
      // is per Room because an event happens in a Room; `usebeeline connect
      // --subscribe joined` is what a greeter is set up with.
      const subscriptions = [...new Set(input.eventSubscriptions ?? [])].filter(isServerEventKind);
      if (subscriptions.length && joined.roomIds.length) {
        await database.query(
          `UPDATE memberships SET event_subscriptions=$3::jsonb
           WHERE identity_id=$1 AND room_id=ANY($2::uuid[])`,
          [pairing.claimed_by, joined.roomIds, JSON.stringify(subscriptions)],
        );
      }
      return { status: 'finished' };
    });
  }

  async execute<Name extends keyof PhoneOperationMap>(
    name: Name,
    input: Input<Name>,
    viewerId: string,
  ): Promise<Output<Name>> {
    if (viewerId === REVIEW_IDENTITY_ID && REVIEW_LOCKED_OPERATIONS.has(name))
      throw new Error(REVIEW_IDENTITY_MESSAGE);
    const scope = input as { workspaceId?: string; roomId?: string };
    if ((scope.workspaceId || scope.roomId) && !SPECTATOR_READ_OPERATIONS.has(name)) {
      const spectator = await this.database.query(
        `SELECT 1 FROM memberships m WHERE m.identity_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND m.role='spectator' AND (m.workspace_id=$2::uuid OR m.workspace_id=(SELECT workspace_id FROM rooms WHERE id=$3::uuid))`,
        [viewerId, scope.workspaceId ?? null, scope.roomId ?? null],
      );
      if (spectator.rowCount) throw new Error('spectator access is read-only (access denied)');
    }
    switch (name) {
      case 'sendRoomMessage':
        return (await this.sendMessage(
          input as Input<'sendRoomMessage'>,
          viewerId,
        )) as Output<Name>;
      case 'sendRoomReply':
        return (await this.sendReply(input as Input<'sendRoomReply'>, viewerId)) as Output<Name>;
      case 'reactToMessage':
        await this.reactToMessage(input as Input<'reactToMessage'>, viewerId);
        return undefined as Output<Name>;
      case 'deleteRoomMessage':
        await this.deleteRoomMessage(input as Input<'deleteRoomMessage'>, viewerId);
        return undefined as Output<Name>;
      case 'setMessageBookmark':
        return (await this.setMessageBookmark(
          input as Input<'setMessageBookmark'>,
          viewerId,
        )) as Output<Name>;
      case 'listMessageBookmarks':
        return (await this.listMessageBookmarks(
          input as Input<'listMessageBookmarks'>,
          viewerId,
        )) as Output<Name>;
      case 'createRoomSchedule':
        return (await this.createRoomSchedule(
          input as Input<'createRoomSchedule'>,
          viewerId,
        )) as Output<Name>;
      case 'listRoomSchedules':
        return (await this.listRoomSchedules(
          (input as Input<'listRoomSchedules'>).roomId,
          viewerId,
        )) as Output<Name>;
      case 'deleteRoomSchedule':
        await this.deleteRoomSchedule(input as Input<'deleteRoomSchedule'>, viewerId);
        return undefined as Output<Name>;
      case 'cancelAgentTurn':
        await this.cancelAgentTurn(input as Input<'cancelAgentTurn'>, viewerId);
        return undefined as Output<Name>;
      case 'createHumanCorner':
        return (await this.createHumanCorner(
          input as Input<'createHumanCorner'>,
          viewerId,
        )) as Output<Name>;
      case 'requestCornerClose':
        await this.requestCornerClose((input as Input<'requestCornerClose'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'decideWritePermission':
        return (await this.decidePermission(
          input as Input<'decideWritePermission'>,
          viewerId,
        )) as Output<Name>;
      case 'decideAgentGrant':
        return (await this.decideAgentGrant(
          input as Input<'decideAgentGrant'>,
          viewerId,
        )) as Output<Name>;
      case 'revokeAgentGrant':
        return (await this.revokeAgentGrant(
          input as Input<'revokeAgentGrant'>,
          viewerId,
        )) as Output<Name>;
      case 'acceptConnectorOffer':
        return (await this.acceptConnectorOffer(
          input as Input<'acceptConnectorOffer'>,
          viewerId,
        )) as Output<Name>;
      case 'createRoomPoll':
        return (await this.createRoomPoll(
          input as Input<'createRoomPoll'>,
          viewerId,
        )) as Output<Name>;
      case 'answerChoice':
        return (await this.answerChoice(input as Input<'answerChoice'>, viewerId)) as Output<Name>;
      case 'skipChoice':
        return (await this.skipChoice(input as Input<'skipChoice'>, viewerId)) as Output<Name>;
      case 'createWorkspace':
        return (await this.createWorkspace(
          input as Input<'createWorkspace'>,
          viewerId,
        )) as Output<Name>;
      case 'updateWorkspace':
        await this.updateWorkspace(input as Input<'updateWorkspace'>, viewerId);
        return undefined as Output<Name>;
      case 'leaveWorkspace':
        await this.leaveWorkspace(input as Input<'leaveWorkspace'>, viewerId);
        return undefined as Output<Name>;
      case 'deleteWorkspace':
        await this.deleteWorkspace(input as Input<'deleteWorkspace'>, viewerId);
        return undefined as Output<Name>;
      case 'addWorkspaceMember':
        return (await this.addWorkspaceMember(
          input as Input<'addWorkspaceMember'>,
          viewerId,
        )) as Output<Name>;
      case 'banWorkspaceMember':
      case 'unbanWorkspaceMember':
        await this.setWorkspaceBan(
          input as Input<'banWorkspaceMember'>,
          viewerId,
          name === 'banWorkspaceMember',
        );
        return undefined as Output<Name>;
      case 'listWorkspaceBans': {
        const request = input as Input<'listWorkspaceBans'>;
        await this.requireWorkspaceManager(request.workspaceId, viewerId);
        const offset =
          Number.isSafeInteger(request.offset) && (request.offset ?? 0) >= 0 ? request.offset! : 0;
        const result = await this.database.query<{
          pubkey: string;
          name: string;
          kind: 'human' | 'agent';
          canLift: boolean;
        }>(
          `SELECT i.id pubkey,i.name,i.kind,
             (actor.role='owner' OR target.role IN ('member','spectator')) "canLift"
           FROM workspace_bans b JOIN identities i ON i.id=b.identity_id
           JOIN memberships target ON target.workspace_id=b.workspace_id AND target.identity_id=b.identity_id AND target.room_id IS NULL
           JOIN memberships actor ON actor.workspace_id=b.workspace_id AND actor.identity_id=$3 AND actor.room_id IS NULL AND actor.removed_at IS NULL
           WHERE b.workspace_id=$1 ORDER BY b.created_at DESC,i.id LIMIT 51 OFFSET $2`,
          [request.workspaceId, offset, viewerId],
        );
        return {
          members: result.rows.slice(0, 50),
          hasMore: result.rows.length > 50,
        } as Output<Name>;
      }
      case 'removeWorkspaceMember':
        await this.removeWorkspaceMember(input as Input<'removeWorkspaceMember'>, viewerId);
        return undefined as Output<Name>;
      case 'createRoom':
        return (await this.createRoom(input as Input<'createRoom'>, viewerId)) as Output<Name>;
      case 'updateRoom':
        await this.updateRoom(input as Input<'updateRoom'>, viewerId);
        return undefined as Output<Name>;
      case 'deleteRoom':
        await this.deleteRoom((input as Input<'deleteRoom'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'leaveRoom':
        await this.leaveRoom((input as Input<'leaveRoom'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'closeChat':
        await this.closeChat((input as Input<'closeChat'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'reopenChat':
        await this.reopenChat((input as Input<'reopenChat'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'addRoomMember':
        return (await this.addRoomMember(
          input as Input<'addRoomMember'>,
          viewerId,
        )) as Output<Name>;
      case 'removeRoomMember':
        await this.removeRoomMember(input as Input<'removeRoomMember'>, viewerId);
        return undefined as Output<Name>;
      case 'resolveDirectMessage':
        return (await this.resolveDirectMessage(
          input as Input<'resolveDirectMessage'>,
          viewerId,
        )) as Output<Name>;
      case 'createInvite':
        return (await this.createInvite(input as Input<'createInvite'>, viewerId)) as Output<Name>;
      case 'resolveInvite': {
        const invite = await this.readInvite((input as Input<'resolveInvite'>).token, viewerId);
        if (!invite) throw new Error('invite not found');
        return invite as Output<Name>;
      }
      case 'redeemInvite':
        return (await this.redeemInvite(input as Input<'redeemInvite'>, viewerId)) as Output<Name>;
      case 'createAgentPairingCode':
        return (await this.createPairing(
          input as Input<'createAgentPairingCode'>,
          viewerId,
        )) as Output<Name>;
      case 'claimAgentPairing': {
        const result = await this.claimAgentPairing(
          (input as Input<'claimAgentPairing'>).code,
          viewerId,
        );
        if (!result) throw new Error('pairing not found');
        return result as Output<Name>;
      }
      case 'updateAgentSoul':
        await this.updateAgentSoul(input as Input<'updateAgentSoul'>, viewerId);
        return undefined as Output<Name>;
      case 'updateAgentModelSelection':
        await this.updateAgentModel(input as Input<'updateAgentModelSelection'>, viewerId);
        return undefined as Output<Name>;
      case 'refreshAgentModelCatalog':
        await this.refreshAgentModelCatalog(input as Input<'refreshAgentModelCatalog'>, viewerId);
        return undefined as Output<Name>;
      case 'updateAgentYolo':
        await this.updateAgentYolo(input as Input<'updateAgentYolo'>, viewerId);
        return undefined as Output<Name>;
      case 'updateAgentAccessPolicy':
        await this.updateAgentAccessPolicy(input as Input<'updateAgentAccessPolicy'>, viewerId);
        return undefined as Output<Name>;
      case 'removeAgent':
        await this.removeAgent(input as Input<'removeAgent'>, viewerId);
        return undefined as Output<Name>;
      case 'updatePersonProfile':
        return (await this.updateProfile(
          input as Input<'updatePersonProfile'>,
          viewerId,
        )) as Output<Name>;
      case 'updateIdentityFace':
        await this.updateFace(input as Input<'updateIdentityFace'>, viewerId);
        return undefined as Output<Name>;
      case 'updateIdentityPushLevel':
        return (await this.updatePushLevel(
          input as Input<'updateIdentityPushLevel'>,
          viewerId,
        )) as Output<Name>;
      case 'setRoomRepository':
        return (await this.setRepository(
          input as Input<'setRoomRepository'>,
          viewerId,
        )) as Output<Name>;
      case 'setRoomTargetBranch':
        return (await this.setTargetBranch(
          input as Input<'setRoomTargetBranch'>,
          viewerId,
        )) as Output<Name>;
      case 'setRoomGitHubEvents':
        return (await this.setGitHubEvents(
          input as Input<'setRoomGitHubEvents'>,
          viewerId,
        )) as Output<Name>;
      case 'removeRoomRepository':
        await this.removeRepositoryBinding(input as Input<'removeRoomRepository'>, viewerId);
        return undefined as Output<Name>;
      case 'listRoomWorkflows':
        await this.requireHumanRoomWorkspaceManager(
          (input as Input<'listRoomWorkflows'>).roomId,
          viewerId,
        );
        return (await this.requireGitHub().listRoomWorkflows(
          (input as Input<'listRoomWorkflows'>).roomId,
        )) as Output<Name>;
      case 'dispatchRoomWorkflow':
        await this.requireHumanRoomWorkspaceManager(
          (input as Input<'dispatchRoomWorkflow'>).roomId,
          viewerId,
        );
        await this.requireGitHub().dispatchRoomWorkflow(
          (input as Input<'dispatchRoomWorkflow'>).roomId,
          (input as Input<'dispatchRoomWorkflow'>).workflowName,
        );
        return undefined as Output<Name>;
      case 'approveCornerMerge':
        return (await this.requireGitHub().approveCornerMerge(
          viewerId,
          input as Input<'approveCornerMerge'>,
        )) as Output<Name>;
      case 'getAuthCapabilities':
        return { github: Boolean(this.github) } as Output<Name>;
      case 'getIdentityRecovery':
        return (await this.identityRecovery(viewerId)) as Output<Name>;
      case 'getManagedIdentity':
        return (await this.managedIdentity(viewerId)) as Output<Name>;
      case 'adoptGitHubHandle':
        return (await this.adoptGitHubHandle(viewerId)) as Output<Name>;
      case 'claimManagedHandle':
        if (
          !/^[a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?$/.test(
            (input as Input<'claimManagedHandle'>).handle,
          )
        )
          throw new Error('invalid managed handle');
        await this.claimManagedHandle(viewerId, (input as Input<'claimManagedHandle'>).handle);
        return (await this.managedIdentity(viewerId)) as Output<Name>;
      case 'listGitHubRepositories': {
        let githubReconnectNeeded = false;
        if ((input as Input<'listGitHubRepositories'>).refresh) {
          try {
            const outcome = await this.requireGitHub().refresh(viewerId);
            githubReconnectNeeded = Boolean(outcome?.githubReconnectNeeded);
          } catch {
            // Never 503 the repo picker: degrade to stored installations/repositories.
          }
        }
        const result = (await this.listRepositories(viewerId)) as Output<Name>;
        return githubReconnectNeeded ? { ...result, githubReconnectNeeded } : result;
      }
      case 'getGitHubRepositoryAccess':
        return (await this.repositoryAccess(
          (input as Input<'getGitHubRepositoryAccess'>).fullName,
          viewerId,
        )) as Output<Name>;
      case 'registerPushDevice':
        return (await this.registerPush(
          input as Input<'registerPushDevice'>,
          viewerId,
        )) as Output<Name>;
      case 'unregisterPushDevice':
        await this.database.query(`DELETE FROM push_devices WHERE token=$1 AND identity_id=$2`, [
          (input as Input<'unregisterPushDevice'>).token,
          viewerId,
        ]);
        return undefined as Output<Name>;
      case 'reportRunningUpdate':
        await this.reportUpdate(input as Input<'reportRunningUpdate'>, viewerId);
        return undefined as Output<Name>;
      case 'readWorkbench':
        return (await this.readWorkbench(
          input as Input<'readWorkbench'>,
          viewerId,
        )) as Output<Name>;
      case 'pairConnector':
        return (await this.pairConnector(
          input as Input<'pairConnector'>,
          viewerId,
        )) as Output<Name>;
      case 'unpairConnector':
        await this.unpairConnector(input as Input<'unpairConnector'>, viewerId);
        return undefined as Output<Name>;
      case 'createWallet':
        return (await createWallet(
          this.database,
          viewerId,
          await this.viewerWorkbenchWorkspace(viewerId),
        )) as Output<Name>;
      case 'readWallet':
        return (await readWallet(
          this.database,
          viewerId,
          await this.viewerWorkbenchWorkspace(viewerId),
        )) as Output<Name>;
      case 'sendFromWallet':
        return (await sendFromWallet(
          this.database,
          viewerId,
          (input as Input<'sendFromWallet'>).workspaceId,
          input as unknown as Input<'sendFromWallet'>,
        )) as Output<Name>;
      case 'grantWalletDelegation':
        return (await grantWalletDelegation(
          this.database,
          viewerId,
          (input as Input<'grantWalletDelegation'>).workspaceId,
        )) as Output<Name>;
      case 'readWalletHistory': {
        // The ledger is keyed on the viewer's identity alone, so the viewer
        // scope IS the authorization — no workspace parameter to project.
        const historyInput = input as unknown as Input<'readWalletHistory'>;
        return {
          entries: await walletHistory(
            this.database,
            viewerId,
            (historyInput as ReadWalletHistoryInput).limit ?? 20,
          ),
        } as Output<Name>;
      }
      case 'readConnectionDetail':
        return (await this.readConnectionDetail(
          input as Input<'readConnectionDetail'>,
          viewerId,
        )) as Output<Name>;
      case 'revokeConnectionGrants':
        return (await this.revokeConnectionGrants(
          input as Input<'revokeConnectionGrants'>,
          viewerId,
        )) as Output<Name>;
      case 'sendPushTest':
        if (!this.sendPushTest) throw new Error('push delivery is not configured');
        await this.sendPushTest(viewerId);
        return undefined as Output<Name>;
      case 'deleteAccount':
        await this.deleteAccount(viewerId);
        return undefined as Output<Name>;
      case 'beginGitHubIdentityBind':
        return (await this.requireGitHub().beginIdentity(
          viewerId,
          input as Input<'beginGitHubIdentityBind'>,
        )) as Output<Name>;
      case 'completeGitHubIdentityBind':
        return (await this.requireGitHub().completeIdentity(
          viewerId,
          input as Input<'completeGitHubIdentityBind'>,
          false,
        )) as Output<Name>;
      case 'recoverGitHubIdentity':
        return (await this.requireGitHub().completeIdentity(
          viewerId,
          input as Input<'recoverGitHubIdentity'>,
          true,
        )) as Output<Name>;
      case 'beginGitHubInstallation':
        return (await this.requireGitHub().beginInstallation(
          viewerId,
          input as Input<'beginGitHubInstallation'>,
        )) as Output<Name>;
      case 'createGitHubRepository':
        return (await this.requireGitHub().createRepository(
          viewerId,
          input as Input<'createGitHubRepository'>,
        )) as Output<Name>;
      case 'uploadMedia': {
        const media = input as Input<'uploadMedia'>;
        return (await this.uploadMedia(
          viewerId,
          media.bytes,
          media.mimeType,
          media.name ?? 'upload',
          25 * 1024 * 1024,
        )) as Output<Name>;
      }
      default:
        throw new Error(`unsupported phone operation: ${String(name)}`);
    }
  }

  async markRead(roomId: string, messageIdValue: string, viewerId: string): Promise<void> {
    const message = await this.database.query<{ exists: boolean }>(
      `SELECT true exists FROM messages WHERE id=$1 AND room_id=$2`,
      [messageIdValue, roomId],
    );
    if (!message.rows[0] || !(await this.hasRoomAccess(roomId, viewerId)))
      throw new Error('message not found');
    await this.database.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
      SELECT $1,$2,message.created_at,$3 FROM messages message WHERE message.id=$3 AND message.room_id=$1
      ON CONFLICT(room_id,identity_id) DO UPDATE SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id,updated_at=now()
      WHERE (EXCLUDED.message_created_at,EXCLUDED.message_id)>(room_read_marks.message_created_at,room_read_marks.message_id)`,
      [roomId, viewerId, messageIdValue],
    );
  }

  /**
   * Put the boundary back in front of `messageIdValue`, so the Room reads
   * unread from that message onward. The mark lands on the newest countable
   * row strictly older than the target; when nothing precedes it the mark is
   * removed entirely and the whole Room is unread again.
   *
   * Unlike `markRead` this is not monotonic — moving the boundary backwards is
   * the entire point — so it writes unconditionally.
   *
   * The target must be a row this viewer's unread count would actually count.
   * Anything else — their own message above all — makes the caller a boundary
   * the count then contradicts: it reported nothing unread while the open Room
   * drew a NEW MESSAGES divider at the chosen row (review 2026-09-22).
   */
  async markUnread(roomId: string, messageIdValue: string, viewerId: string): Promise<void> {
    const message = await this.database.query<{ exists: boolean }>(
      `SELECT true exists FROM messages WHERE id=$1 AND room_id=$2`,
      [messageIdValue, roomId],
    );
    if (!message.rows[0] || !(await this.hasRoomAccess(roomId, viewerId)))
      throw new Error('message not found');
    const countable = await this.database.query<{ exists: boolean }>(
      `SELECT true exists FROM messages message
       WHERE message.id=$1 AND message.room_id=$3 AND ${unreadMessageSql('message')}`,
      [messageIdValue, viewerId, roomId],
    );
    // 'invalid' is what the router reads as a 400 — the row is real and
    // readable, it is simply not something this viewer can hold unread.
    if (!countable.rows[0])
      throw new Error(
        'messageId is invalid: only a row that counts as unread can be marked unread',
      );
    const previous = (
      await this.database.query<{ id: string; created_at: Date }>(
        `SELECT earlier.id,earlier.created_at FROM messages target
         JOIN messages earlier ON earlier.room_id=target.room_id
           AND (earlier.created_at,earlier.id)<(target.created_at,target.id)
           AND earlier.presentation<>'activity'
           AND ${hiddenWakeCardSql('earlier')}
         WHERE target.id=$1 AND target.room_id=$2
         ORDER BY earlier.created_at DESC,earlier.id DESC LIMIT 1`,
        [messageIdValue, roomId],
      )
    ).rows[0];
    if (previous) {
      await this.database.query(
        `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(room_id,identity_id) DO UPDATE
           SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id,updated_at=now()`,
        [roomId, viewerId, previous.created_at, previous.id],
      );
    } else {
      await this.database.query(`DELETE FROM room_read_marks WHERE room_id=$1 AND identity_id=$2`, [
        roomId,
        viewerId,
      ]);
    }
  }

  async uploadMedia(
    viewerId: string,
    bytes: Uint8Array,
    mimeType: string,
    name: string,
    maximumBytes: number,
  ) {
    if (!this.objects) throw new Error('object storage is not configured');
    if (!bytes.length || bytes.length > maximumBytes)
      throw new Error('media size is outside the allowed range');
    const stored = await this.objects.uploadSharedFile(viewerId, bytes, mimeType, name);
    return {
      url: stored.url,
      name: stored.title,
      mimeType: stored.mimeType,
      size: stored.size,
      sha256: stored.sha256,
    };
  }

  private async sendMessage(
    input: Input<'sendRoomMessage'>,
    author: string,
  ): Promise<Output<'sendRoomMessage'>> {
    if (!this.routingTransaction)
      return this.database.transaction((db) =>
        new PhoneService(
          db,
          this.publicOrigin,
          this.github,
          this.sendPushTest,
          this.live,
          true,
        ).sendMessage(input, author),
      );
    if (!(await this.hasRoomAccess(input.roomId, author))) throw new Error('room access denied');
    await this.assertRoomIsWritable(input.roomId, author);
    const id = input.messageId ?? messageId();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('messageId is invalid');
    const attachments = JSON.stringify(input.attachments ?? []);
    const noticeAgentIds = await this.unansweredMentionTargets(input.roomId, author, input.text);
    const values = [id, input.roomId, author, input.text, attachments];
    return this.database.transaction(async (database) => {
      const inserted = await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,attachments)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO NOTHING`,
        values,
      );
      if (!inserted.rowCount) {
        const retry = await database.query(
          `SELECT 1 FROM messages
         WHERE id=$1 AND room_id=$2 AND author_id=$3 AND text=$4
           AND attachments=$5::jsonb
           AND reply_to_message_id IS NULL`,
          values,
        );
        if (!retry.rowCount) throw new Error('messageId is invalid');
        return {
          messageId: id,
          activeSteerAgentIds: await this.activeSteerAgentIds(database, id),
        };
      }
      const lifecycleCommand = await routeHumanMessage(database, id);
      if (!lifecycleCommand)
        await this.noteUnansweredMentions(input.roomId, author, noticeAgentIds, id);
      return {
        messageId: id,
        activeSteerAgentIds: await this.activeSteerAgentIds(database, id),
      };
    });
  }
  private async createRoomSchedule(input: Input<'createRoomSchedule'>, viewerId: string) {
    const target = await this.requireTopLevelRoom(input.roomId);
    if (target.workspace_id !== input.workspaceId) throw new Error('room is not in workspace');
    await this.requireRoomWorkspaceManager(input.roomId, viewerId);
    if (typeof input.message !== 'string' || !input.message.trim())
      throw new Error('schedule message is required');
    if (!input.cadence || typeof input.cadence !== 'object')
      throw new Error('schedule cadence is invalid');
    validateScheduleCadence(input.cadence);
    const agent = await this.database.query(
      `SELECT 1 FROM identities identity
       JOIN memberships membership ON membership.identity_id=identity.id
       WHERE identity.id=$1 AND identity.kind='agent' AND membership.room_id=$2
         AND membership.workspace_id=$3 AND membership.removed_at IS NULL`,
      [input.agentId, input.roomId, input.workspaceId],
    );
    if (!agent.rowCount) throw new Error('agent not found in room');
    const id = randomUUID();
    const nextRunAt = nextScheduleOccurrence(input.cadence, new Date());
    const inserted = await this.database.query<RoomScheduleRow>(
      `INSERT INTO agent_schedules(
         id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       RETURNING id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,created_at`,
      [
        id,
        input.workspaceId,
        input.roomId,
        input.agentId,
        viewerId,
        JSON.stringify(input.cadence),
        input.message.trim(),
        nextRunAt,
      ],
    );
    return roomSchedule(inserted.rows[0]!);
  }
  private async listRoomSchedules(roomId: string, viewerId: string) {
    await this.requireTopLevelRoom(roomId);
    await this.requireRoomWorkspaceManager(roomId, viewerId);
    const schedules = await this.database.query<RoomScheduleRow>(
      `SELECT schedule.id,schedule.workspace_id,schedule.room_id,schedule.agent_id,
              schedule.creator_id,schedule.cadence,schedule.message,schedule.next_run_at,
              schedule.created_at,surface.parent_id surface_parent_id,surface.name surface_name
       FROM agent_schedules schedule
       JOIN rooms surface ON surface.id=schedule.room_id
       WHERE surface.id=$1 OR surface.parent_id=$1
       ORDER BY schedule.created_at,schedule.id`,
      [roomId],
    );
    return { schedules: schedules.rows.map(roomSchedule) };
  }
  private async deleteRoomSchedule(
    input: Input<'deleteRoomSchedule'>,
    viewerId: string,
  ): Promise<void> {
    await this.requireTopLevelRoom(input.roomId);
    await this.requireRoomWorkspaceManager(input.roomId, viewerId);
    const deleted = await this.database.query(
      `DELETE FROM agent_schedules schedule USING rooms surface
       WHERE schedule.id=$1 AND surface.id=schedule.room_id
         AND (surface.id=$2 OR surface.parent_id=$2)`,
      [input.scheduleId, input.roomId],
    );
    if (!deleted.rowCount) throw new Error('schedule not found');
  }
  private async sendReply(
    input: Input<'sendRoomReply'>,
    author: string,
  ): Promise<Output<'sendRoomReply'>> {
    if (!this.routingTransaction)
      return this.database.transaction((db) =>
        new PhoneService(
          db,
          this.publicOrigin,
          this.github,
          this.sendPushTest,
          this.live,
          true,
        ).sendReply(input, author),
      );
    const parent = await this.database.query<{
      root_message_id: string | null;
      author_id: string;
      author_kind: 'human' | 'agent';
      direct: boolean;
    }>(
      `SELECT message.root_message_id,message.author_id,identity.kind author_kind,
              room.direct_participants IS NOT NULL direct
       FROM messages message
       JOIN identities identity ON identity.id=message.author_id
       JOIN rooms room ON room.id=message.room_id
       WHERE message.id=$1 AND message.room_id=$2`,
      [input.parentMessageId, input.roomId],
    );
    if (!parent.rows[0] || !(await this.hasRoomAccess(input.roomId, author)))
      throw new Error('reply parent is not in this room');
    await this.assertRoomIsWritable(input.roomId, author);
    const id = input.messageId ?? messageId();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('messageId is invalid');
    // A reply in a DM addresses the agent it answers without naming it. That
    // is the DM's own doing, not a tag: `routeHumanMessage` wakes every
    // participant of a direct Room, so the address survives without a list.
    const noticeAgentIds = await this.unansweredMentionTargets(input.roomId, author, input.text);
    const values = [
      id,
      input.roomId,
      author,
      input.text,
      JSON.stringify(input.attachments ?? []),
      input.parentMessageId,
      parent.rows[0].root_message_id ?? input.parentMessageId,
    ];
    return this.database.transaction(async (database) => {
      const inserted = await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,attachments,reply_to_message_id,root_message_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(id) DO NOTHING`,
        values,
      );
      if (!inserted.rowCount) {
        const retry = await database.query(
          `SELECT 1 FROM messages
         WHERE id=$1 AND room_id=$2 AND author_id=$3 AND text=$4
           AND attachments=$5::jsonb
           AND reply_to_message_id=$6 AND root_message_id=$7`,
          values,
        );
        if (!retry.rowCount) throw new Error('messageId is invalid');
        return {
          messageId: id,
          activeSteerAgentIds: await this.activeSteerAgentIds(database, id),
        };
      }
      const lifecycleCommand = await routeHumanMessage(database, id);
      if (!lifecycleCommand)
        await this.noteUnansweredMentions(input.roomId, author, noticeAgentIds, id);
      return {
        messageId: id,
        activeSteerAgentIds: await this.activeSteerAgentIds(database, id),
      };
    });
  }

  private async reactToMessage(input: Input<'reactToMessage'>, viewerId: string): Promise<void> {
    if (!MESSAGE_REACTION_EMOJIS.includes(input.emoji)) throw new Error('reaction is invalid');
    await this.database.transaction(async (database) => {
      const row = (
        await database.query<{ reactions: Record<string, string[]> }>(
          `SELECT message.reactions FROM messages message
           JOIN memberships membership ON membership.room_id=message.room_id
             AND membership.identity_id=$3 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=membership.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
             AND workspace_member.removed_at IS NULL
           WHERE message.id=$1 AND message.room_id=$2 AND message.presentation='message'
             AND message.deleted_at IS NULL
           FOR UPDATE OF message`,
          [input.messageId, input.roomId, viewerId],
        )
      ).rows[0];
      if (!row) throw new Error('message is not available for reaction');
      const reactions = { ...(row.reactions ?? {}) };
      const reactors = new Set(reactions[input.emoji] ?? []);
      if (reactors.has(viewerId)) reactors.delete(viewerId);
      else reactors.add(viewerId);
      if (reactors.size) reactions[input.emoji] = [...reactors];
      else delete reactions[input.emoji];
      await database.query(`UPDATE messages SET reactions=$3::jsonb WHERE id=$1 AND room_id=$2`, [
        input.messageId,
        input.roomId,
        JSON.stringify(reactions),
      ]);
    });
  }

  private async deleteRoomMessage(
    input: Input<'deleteRoomMessage'>,
    viewerId: string,
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(input.messageId)) throw new Error('messageId is invalid');
    await this.database.transaction(async (database) => {
      const deleted = await database.query(
        `UPDATE messages message SET deleted_at=COALESCE(message.deleted_at,now()),
           deleted_by=COALESCE(message.deleted_by,$3),text='',attachments='[]'::jsonb,reactions='{}'::jsonb
         FROM rooms room
         WHERE message.id=$1 AND message.room_id=$2 AND message.room_id=room.id
           AND message.presentation='message' AND EXISTS(
               SELECT 1 FROM memberships member
               WHERE member.room_id=message.room_id AND member.identity_id=$3
                 AND member.removed_at IS NULL
             ) AND (message.author_id=$3 OR EXISTS(
               SELECT 1 FROM memberships manager
               WHERE manager.workspace_id=room.workspace_id AND manager.room_id IS NULL
                 AND manager.identity_id=$3 AND manager.role IN ('owner','admin')
                 AND manager.removed_at IS NULL
             ))
         RETURNING message.id`,
        [input.messageId, input.roomId, viewerId],
      );
      if (!deleted.rowCount) throw new Error('message is not available for deletion');
      await tombstoneInstitutionalMemoryForMessage(database, input.messageId);
    });
  }

  private async setMessageBookmark(
    input: Input<'setMessageBookmark'>,
    viewerId: string,
  ): Promise<Output<'setMessageBookmark'>> {
    if (!/^[0-9a-f]{64}$/.test(input.messageId)) throw new Error('messageId is invalid');
    if (!input.bookmarked) {
      await this.database.query(
        `DELETE FROM message_bookmarks WHERE identity_id=$1 AND message_id=$2`,
        [viewerId, input.messageId],
      );
      return { bookmarked: false };
    }
    return this.database.transaction(async (database) => {
      const source = (
        await database.query<{
          workspace_id: string;
          room_name: string;
          room_kind: 'room' | 'corner';
          message_created_at: Date;
        }>(
          `SELECT room.workspace_id,room.name room_name,
             CASE WHEN room.parent_id IS NULL THEN 'room' ELSE 'corner' END room_kind,
             message.created_at message_created_at
           FROM messages message
           JOIN rooms room ON room.id=message.room_id
           JOIN memberships membership ON membership.room_id=room.id
             AND membership.identity_id=$3 AND membership.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$3
             AND workspace_member.removed_at IS NULL
           WHERE message.id=$1 AND message.room_id=$2 AND message.presentation='message'`,
          [input.messageId, input.roomId, viewerId],
        )
      ).rows[0];
      if (!source) throw new Error('message is not available for bookmarking');
      await database.query(
        `INSERT INTO message_bookmarks(
           identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,
           message_created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(identity_id,message_id) DO NOTHING`,
        [
          viewerId,
          source.workspace_id,
          input.roomId,
          input.messageId,
          source.room_name,
          source.room_kind,
          source.message_created_at,
        ],
      );
      return { bookmarked: true };
    });
  }

  private async listMessageBookmarks(
    input: Input<'listMessageBookmarks'>,
    viewerId: string,
  ): Promise<Output<'listMessageBookmarks'>> {
    await this.requireWorkspaceMember(input.workspaceId, viewerId);
    const result = await this.database.query<{
      message_id: string;
      workspace_id: string;
      room_id: string;
      room_name: string;
      room_kind: 'room' | 'corner';
      message_created_at: Date;
      bookmarked_at: Date;
      available: boolean;
      text: string | null;
      author_id: string | null;
      author_kind: 'human' | 'agent' | null;
      author_name: string | null;
      author_handle: string | null;
      author_avatar: string | null;
      author_face: string | null;
    }>(
      `SELECT bookmark.message_id,bookmark.workspace_id,bookmark.room_id,
         COALESCE(room.name,bookmark.source_room_name) room_name,
         bookmark.source_room_kind room_kind,
         bookmark.message_created_at,bookmark.created_at bookmarked_at,
         (message.id IS NOT NULL AND message.deleted_at IS NULL AND room.id IS NOT NULL AND room_member.identity_id IS NOT NULL) available,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN message.text END text,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.id END author_id,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.kind END author_kind,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.name END author_name,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.handle END author_handle,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.avatar END author_avatar,
         CASE WHEN room_member.identity_id IS NOT NULL AND message.deleted_at IS NULL THEN author.face_id END author_face
       FROM message_bookmarks bookmark
       LEFT JOIN rooms room ON room.id=bookmark.room_id AND room.workspace_id=bookmark.workspace_id
       LEFT JOIN memberships room_member ON room_member.room_id=room.id
         AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
       LEFT JOIN messages message ON message.id=bookmark.message_id AND message.room_id=room.id
       LEFT JOIN identities author ON author.id=message.author_id
       WHERE bookmark.workspace_id=$1 AND bookmark.identity_id=$2
       ORDER BY bookmark.created_at DESC,bookmark.message_id`,
      [input.workspaceId, viewerId],
    );
    return {
      bookmarks: result.rows.map((row) => ({
        messageId: row.message_id,
        workspaceId: row.workspace_id,
        roomId: row.room_id,
        roomName: row.room_name,
        roomKind: row.room_kind,
        messageCreatedAt: unix(row.message_created_at),
        bookmarkedAt: unix(row.bookmarked_at),
        available: row.available,
        ...(row.available && row.text !== null ? { text: row.text } : {}),
        ...(row.available && row.author_id && row.author_kind && row.author_name
          ? {
              author: identity(
                {
                  id: row.author_id,
                  kind: row.author_kind,
                  name: row.author_name,
                  handle: row.author_handle,
                  avatar: row.author_avatar,
                  face_id: row.author_face,
                },
                this.publicOrigin,
              ),
            }
          : {}),
      })),
    };
  }

  /**
   * Active turns targeted by the human write. The command and message commit
   * in one transaction, so the phone can distinguish a server-accepted steer
   * from text that merely looked addressed locally.
   */
  private async activeSteerAgentIds(database: SqlDatabase, messageIdValue: string) {
    const commands = await database.query<{ agent_id: string }>(
      `SELECT DISTINCT command.agent_id
       FROM agent_commands command
       JOIN agent_turns turn ON turn.room_id=command.room_id
         AND turn.agent_id=command.agent_id AND turn.status='working'
         AND turn.request_id<>command.turn_request_id
       WHERE command.source_message_id=$1 AND command.action='input'
       ORDER BY command.agent_id`,
      [messageIdValue],
    );
    return commands.rows.map((command) => command.agent_id);
  }
  /**
   * Say out loud why a mentioned agent will not answer. ONE producer for every
   * reason a mention lands and nothing happens.
   *
   * Silence is the failure this exists to end. A mention dropped by the agent's
   * access policy, a mention nobody is alive to read, and a mention of an agent
   * that is not in this corner all look identical in a Room, and all three look
   * like a broken product. So the SERVER — which owns the policy, sees the
   * helper's presence and knows the roster — inscribes one ordinary system line
   * (`presentation='system'`, the one grammar in `system-line.ts`). The line
   * mentions nobody, so it wakes no daemon and reaches a phone only where every
   * message already does — a DM, which is where the person who was refused most
   * needs to hear it.
   *
   * The reasons are ordered, not summed: an agent that is not in the corner is
   * told that and nothing else, because its policy and its availability are beside
   * the point. At most one line per (Room, agent, sender, reason) per
   * `ACCESS_NOTICE_WINDOW_MS` — the id is derived from the window bucket, so a
   * repeat inside it collides on the primary key and writes nothing. A chatty
   * non-permitted member gets one explanation, not a storm.
   *
   * Never throws: a notice is a courtesy on top of a message that is already
   * written, and must not fail the send.
   *
   * `afterMessageId` is the message the mentions rode in on: the line is its
   * consequence, so it is stamped strictly past that message's second and can
   * never render above it (see `orderingFloor` in `system-line.ts`).
   */
  private async noteUnansweredMentions(
    roomId: string,
    senderId: string,
    agentIds: readonly string[],
    afterMessageId?: string,
  ): Promise<void> {
    if (!agentIds.length) return;
    try {
      const sender = (
        await this.database.query<{ kind: 'human' | 'agent'; handle: string | null }>(
          `SELECT kind,handle FROM identities WHERE id=$1`,
          [senderId],
        )
      ).rows[0];
      if (!sender) return;
      const agents = await this.database.query<{
        agent_id: string;
        agent_name: string;
        agent_handle: string | null;
        access_policy: unknown;
        owner_id: string | null;
        owner_handle: string | null;
        member: boolean;
        corner: boolean;
        reachable: boolean;
      }>(
        // Reachability is a fact about the HELPER, not about this Room. A
        // mention in a corner may rely on the same daemon's lifecycle fact
        // in a top-level Room, so the presence lookup intentionally has no
        // room filter.
        `SELECT identity.id agent_id,COALESCE(NULLIF(identity.name,''),'The agent') agent_name,
                identity.handle agent_handle,
                a.access_policy,a.owner_id,owner.handle owner_handle,
                EXISTS(SELECT 1 FROM rooms room WHERE room.id=$2 AND room.parent_id IS NOT NULL) corner,
                EXISTS(
                  SELECT 1 FROM memberships membership
                  WHERE membership.room_id=$2 AND membership.identity_id=identity.id
                    AND membership.removed_at IS NULL
                ) member,
                COALESCE((SELECT lo.body->>'status'='online'
                    AND lo.updated_at >= now()-make_interval(secs => $3::double precision / 1000)
                  FROM live_outputs lo
                  WHERE lo.agent_id=identity.id AND lo.kind='presence'
                  ORDER BY lo.updated_at DESC LIMIT 1),false) reachable
         FROM identities identity
         LEFT JOIN agents a ON a.agent_id=identity.id
         LEFT JOIN identities owner ON owner.id=a.owner_id
         WHERE identity.id=ANY($1::text[]) AND identity.kind='agent'`,
        [[...agentIds], roomId, AGENT_REACHABLE_HORIZON_MS],
      );
      const bucket = accessNoticeBucket(Date.now());
      for (const agent of agents.rows) {
        const phrase = this.unansweredMentionPhrase(agent, sender, senderId);
        if (!phrase) continue;
        await systemLine(this.database, {
          roomId,
          id: createHash('sha256')
            .update(
              `access-notice|${roomId}|${agent.agent_id}|${senderId}|${phrase.reason}|${bucket}`,
            )
            .digest('hex'),
          subject: { kind: 'agent', id: agent.agent_id, name: agent.agent_name },
          verb: phrase.verb,
          ...(phrase.object ? { object: phrase.object } : {}),
          consequence: phrase.consequence,
          afterMessageId,
        });
      }
    } catch (error) {
      console.error('[server] could not inscribe an unanswered mention:', error);
    }
  }

  /** The one reason this mention goes unanswered, or nothing when it will be. */
  private unansweredMentionPhrase(
    agent: {
      agent_id: string;
      agent_name: string;
      agent_handle: string | null;
      access_policy: unknown;
      owner_id: string | null;
      owner_handle: string | null;
      member: boolean;
      corner: boolean;
      reachable: boolean;
    },
    sender: { kind: 'human' | 'agent'; handle: string | null },
    senderId: string,
  ):
    | { reason: string; verb: string; consequence: string; object?: { text: string; id: string } }
    | undefined {
    // A corner is carried by its MEMBERS, so a mention of an agent that is not
    // one resolves fine and then produces nothing at all — no turn, no message,
    // no error.
    if (!agent.member) {
      return agent.corner
        ? {
            reason: 'not-a-member',
            verb: 'could not be reached',
            consequence: 'not a member of this corner',
          }
        : undefined;
    }
    // An agent is a server-validated Room member; the owner's cost policy gates
    // people, and an agent-to-agent hop is capped elsewhere.
    const permitted =
      sender.kind !== 'human' ||
      senderMayAddressAgent(
        parseAgentAccessPolicy(agent.access_policy),
        senderId,
        agent.owner_id ?? undefined,
      );
    // A person is named by their @handle, never by a display name: the handle is
    // the address the reader can actually use, and it is unique where a display
    // name is not. A person with no handle is left unnamed rather than described.
    const asked = personMention(sender.handle);
    const object = asked ? { text: asked, id: senderId } : undefined;
    const agentMention = systemIdentityMention({
      id: agent.agent_id,
      kind: 'agent',
      name: agent.agent_name,
      handle: agent.agent_handle,
    });
    if (!permitted) {
      return {
        reason: 'refused',
        verb: 'did not answer',
        ...(object ? { object } : {}),
        consequence: `only ${personMention(agent.owner_handle) ?? 'the owner'} may address ${agentMention}. Ask the user for permission to access the agent in the members page`,
      };
    }
    if (agent.reachable) return undefined;
    return {
      reason: 'unreachable',
      verb: 'did not answer',
      ...(object ? { object } : {}),
      consequence: 'its helper is offline',
    };
  }
  /**
   * The agents this message tries to reach, for the sole purpose of saying so
   * when one of them cannot answer. This is NOT the message's address — who a
   * message tags is read from its text on demand (`message-mentions.ts`) and
   * never recorded. It is the wider set worth explaining: an agent named in a
   * corner it has not joined is unreachable in a way the writer should hear
   * about, and a tag alone would say nothing.
   */
  private async unansweredMentionTargets(
    roomId: string,
    author: string,
    text: string,
  ): Promise<readonly string[]> {
    const authorKind = (
      await this.database.query<{ kind: 'human' | 'agent' }>(
        `SELECT kind FROM identities WHERE id=$1`,
        [author],
      )
    ).rows[0]?.kind;
    if (authorKind !== 'human') return [];
    const resolvedMembers = await resolveCurrentMemberMentions(this.database, roomId, text, author);
    const typedHandles = typedMentionHandles(text);
    const noticeAgentIds = new Set(
      resolvedMembers.filter((member) => member.kind === 'agent').map((member) => member.id),
    );
    const directAgents = await this.database.query<{ id: string }>(
      `SELECT identity.id
       FROM rooms room
       JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(room.direct_participants)='array'
           THEN room.direct_participants ELSE '[]'::jsonb END
       ) participant(id) ON true
       JOIN identities identity ON identity.id=participant.id AND identity.kind='agent'
       JOIN memberships membership ON membership.room_id=room.id
         AND membership.identity_id=identity.id AND membership.removed_at IS NULL
       WHERE room.id=$1 AND jsonb_array_length(
         CASE WHEN jsonb_typeof(room.direct_participants)='array'
           THEN room.direct_participants ELSE '[]'::jsonb END
       )=2`,
      [roomId],
    );
    // A private two-member DM with one agent is already an addressed surface:
    // every human message in it is for that sole helper, including the first
    // untagged message and a reply to the human's own row. The address is the
    // Room, not a tag, and `routeHumanMessage` reads it from the participant
    // list — so this only decides whether an unreachable helper is worth a word.
    if (directAgents.rows.length === 1) {
      noticeAgentIds.add(directAgents.rows[0]!.id);
    }
    const absentCornerAgents = await this.database.query<{ id: string; handle: string }>(
      `SELECT identity.id,identity.handle
       FROM rooms room
       JOIN memberships workspace_membership ON workspace_membership.workspace_id=room.workspace_id
         AND workspace_membership.room_id IS NULL AND workspace_membership.removed_at IS NULL
       JOIN identities identity ON identity.id=workspace_membership.identity_id
         AND identity.kind='agent' AND identity.handle IS NOT NULL
       LEFT JOIN memberships room_membership ON room_membership.room_id=room.id
         AND room_membership.identity_id=identity.id AND room_membership.removed_at IS NULL
       WHERE room.id=$1 AND room.parent_id IS NOT NULL AND room_membership.identity_id IS NULL`,
      [roomId],
    );
    const resolvedHandles = new Set(resolvedMembers.map((member) => member.handle));
    const absentByHandle = new Map<string, string[]>();
    for (const agent of absentCornerAgents.rows) {
      const handle = agent.handle;
      const candidates = absentByHandle.get(handle) ?? [];
      candidates.push(agent.id);
      absentByHandle.set(handle, candidates);
    }
    for (const handle of typedHandles) {
      if (resolvedHandles.has(handle)) continue;
      const candidates = absentByHandle.get(handle);
      if (candidates?.length === 1) noticeAgentIds.add(candidates[0]!);
    }
    return [...noticeAgentIds];
  }
  /**
   * Stop a turn in progress, at the asker's word.
   *
   * The authority is the request, not the Room: whoever wrote the message this
   * turn answers may withdraw it, and nobody else may — not a Workspace owner,
   * not the agent's owner, not another member watching the line tick. A
   * question is the asker's to take back, and a Room where anyone can silence
   * anyone else's agent mid-sentence is a different feature with different
   * consequences.
   *
   * Three facts settle together, in one transaction, and in this order for a
   * reason:
   *
   *   1. The receipt turns `cancelled`. This is what retires the turn status
   *      line on every reader's phone, and it is written the moment the stop is
   *      accepted rather than when the helper gets around to obeying — the
   *      person withdrew the question, so nobody is waiting for that answer
   *      any more, whatever the harness does next. `cancelled` is terminal
   *      (`DaemonService.turnReceipt`), so the run that lands a second later
   *      cannot overwrite the stop with `complete`.
   *   2. One attributed system line inscribes WHO stopped it. A turn that
   *      simply vanished would read as an agent that gave up; the Room carries
   *      the actual fact instead, in the ordinary grammar, naming the person by
   *      handle.
   *   3. That same line IS the intake item. It mentions the agent — the only
   *      thing that wakes a daemon — and carries the stopped turn's request id
   *      in the row's `request_id`, which is how the helper knows which of its
   *      sessions to cancel. `turn-cancelled` is a CONTROL kind, so it can
   *      never start the very turn it exists to end.
   */
  private async cancelAgentTurn(input: Input<'cancelAgentTurn'>, viewerId: string) {
    if (!(await this.hasRoomAccess(input.roomId, viewerId))) throw new Error('room access denied');
    // A corner's root request may live in its parent Room. Authority is
    // checked against current membership under lock before settling it.
    const running = (
      await this.database.query<{ author_id: string }>(
        `SELECT trigger.author_id
         FROM agent_turns turn
         JOIN agent_commands command ON command.room_id=turn.room_id AND command.agent_id=turn.agent_id
           AND command.turn_request_id=turn.request_id
         JOIN messages trigger ON trigger.id=command.root_source_message_id
         WHERE turn.room_id=$1 AND turn.request_id=$2 AND turn.agent_id=$3
           AND turn.status='working'`,
        [input.roomId, input.requestId, input.agentId],
      )
    ).rows[0];
    if (!running) throw new Error('running turn not found');
    const stopper = await this.requireIdentity(viewerId);
    const agent = await this.requireIdentity(input.agentId);
    await this.database.transaction(async (database) => {
      const member = (
        await database.query<{ role: string }>(
          `SELECT room_member.role FROM memberships room_member
         JOIN rooms room ON room.id=room_member.room_id
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=room_member.identity_id
           AND workspace_member.removed_at IS NULL
         WHERE room_member.room_id=$1 AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
         FOR SHARE OF room_member,workspace_member`,
          [input.roomId, viewerId],
        )
      ).rows[0];
      if (!member) throw new Error('room access denied');
      if (running.author_id !== viewerId && member.role !== 'owner' && member.role !== 'admin')
        throw new Error(TURN_REQUESTER_AUTHORITY_MESSAGE);
      await database.query(
        `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 FOR UPDATE`,
        [input.roomId, input.agentId, input.requestId],
      );
      const stopped = await database.query(
        `UPDATE agent_turns SET status='cancelled',created_at=now()
         WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'`,
        [input.roomId, input.requestId, input.agentId],
      );
      // Lost the race with the turn's own settling receipt: it answered, and
      // there is nothing left to stop. Nothing is written, so no line claims a
      // stop that never happened.
      if (!stopped.rowCount) throw new Error('running turn not found');
      await systemLine(database, {
        roomId: input.roomId,
        authorId: viewerId,
        subject: identitySubject({ id: stopper.pubkey, kind: stopper.kind, name: stopper.name }),
        verb: 'stopped',
        object: { text: agent.name, id: agent.pubkey },
        consequence: 'turn cancelled',
        kind: 'turn-cancelled',
        wakes: [input.agentId],
        requestId: input.requestId,
      });
    });
    // No publish here on purpose. Every phone operation carrying a `roomId`
    // already invalidates that Room (`server.ts`), which is what repaints the
    // status line; an `agentId`-stamped `turn` invalidate would additionally be
    // read as the agent's OWN turn narration and suppressed by `wakesCorner` —
    // in a corner, the very reader that must hear this.
  }
  /**
   * Close a corner at a current human member's explicit request.
   *
   * The server owns both effects: it applies the same terminal corner state
   * as helper completion and turns every active assignment into the existing
   * structured stop command. No chat sentence is created or interpreted.
   */
  private async requestCornerClose(roomId: string, viewerId: string) {
    const parentId = await this.database.transaction(async (database) => {
      const access = await database.query(
        `SELECT room_member.identity_id FROM memberships room_member
         JOIN rooms room ON room.id=room_member.room_id
         JOIN memberships workspace_member
           ON workspace_member.workspace_id=room.workspace_id
          AND workspace_member.room_id IS NULL
          AND workspace_member.identity_id=room_member.identity_id
          AND workspace_member.removed_at IS NULL
         JOIN identities viewer ON viewer.id=room_member.identity_id AND viewer.kind='human'
         WHERE room_member.room_id=$1 AND room_member.identity_id=$2
           AND room_member.removed_at IS NULL
         FOR SHARE OF room_member,workspace_member,room,viewer`,
        [roomId, viewerId],
      );
      if (!access.rowCount) throw new Error('room access denied');
      const room = (
        await database.query<{ archived: boolean; created_by: string | null; kind: string }>(
          `SELECT room.archived_at IS NOT NULL archived,room.created_by,fact.kind
           FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id
           WHERE room.id=$1 AND room.parent_id IS NOT NULL FOR UPDATE OF room,fact`,
          [roomId],
        )
      ).rows[0];
      if (!room) throw new Error('corner not found');
      if (room.kind === 'human' && room.created_by !== viewerId)
        throw new Error('corner close access denied: only the creator can close this corner');

      if (!room.archived) {
        const active = await database.query<CommandRow>(
          `SELECT * FROM agent_commands
           WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')
           ORDER BY created_at DESC,id DESC FOR UPDATE`,
          [roomId],
        );
        const assignments = new Map<string, CommandRow>();
        for (const command of active.rows) {
          const key = `${command.agent_id}:${command.turn_request_id}`;
          if (!assignments.has(key)) assignments.set(key, command);
        }
        for (const command of assignments.values())
          await createAgentCommand(database, {
            roomId,
            agentId: command.agent_id,
            sourceMessageId: command.source_message_id,
            turnRequestId: command.turn_request_id,
            action: 'stop',
            reason: 'corner_close',
            parent: command,
            retainDepth: true,
          });
        await database.query(
          `UPDATE agent_commands SET state='cancelled',completed_at=now()
           WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')`,
          [roomId],
        );
        await database.query(
          `UPDATE agent_turns SET status='cancelled',created_at=now()
           WHERE room_id=$1 AND status='working'`,
          [roomId],
        );
      }
      return (await closeCornerState(database, roomId)).parentId;
    });
    this.live?.publish({ type: 'invalidate', roomId: parentId, reason: 'corner' });
  }
  private async decidePermission(input: Input<'decideWritePermission'>, viewerId: string) {
    const pending = (
      await this.database.query<{
        principal_id: string;
        request_id: string;
        status: string;
        card: Record<string, unknown> | null;
      }>(
        `SELECT p.principal_id,p.request_id,p.status,card.card
         FROM permission_authority p
         LEFT JOIN LATERAL (
           SELECT m.card FROM messages m
           WHERE m.room_id=p.room_id AND m.card_type='permission'
             AND m.card->>'permissionId'=p.permission_id
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1
         ) card ON true
         WHERE p.permission_id=$1 AND p.room_id=$2`,
        [input.permissionId, input.roomId],
      )
    ).rows[0];
    if (!pending || pending.status !== 'pending') throw new Error('permission not found');
    if (viewerId !== pending.principal_id)
      await this.requireRoomWorkspaceManager(input.roomId, viewerId);
    const card = pending.card;
    const cardAgent = card?.agent as { pubkey?: unknown } | undefined;
    if (
      pending.request_id !== input.requestId ||
      cardAgent?.pubkey !== input.agentId ||
      card?.repository !== input.repository
    )
      throw new Error('permission decision is invalid');
    const status = input.decision === 'allow' ? 'authorized' : 'denied';
    const id = messageId();
    const decider = await this.requireIdentity(viewerId);
    const agent = await this.requireIdentity(input.agentId);
    const requester = await this.requireIdentity(pending.principal_id);
    await this.database.transaction(async (database) => {
      const updated = await database.query(
        `UPDATE permission_authority SET status=$2,updated_at=now()
         WHERE permission_id=$1 AND room_id=$3 AND status='pending'`,
        [input.permissionId, status, input.roomId],
      );
      if (!updated.rowCount) throw new Error('permission not found');
      const tool = typeof card?.tool === 'string' ? card.tool : 'edit files';
      await systemLine(database, {
        id,
        roomId: input.roomId,
        authorId: viewerId,
        subject: identitySubject({ id: decider.pubkey, kind: decider.kind, name: decider.name }),
        verb: input.decision === 'allow' ? 'allowed' : 'denied',
        object: {
          text: `${systemIdentityMention({
            id: agent.pubkey,
            kind: agent.kind,
            name: agent.name,
            handle: agent.handle ?? null,
          })} to ${tool}`,
          id: agent.pubkey,
        },
        presentation: 'card',
        cardType: 'permission',
        card: {
          permissionId: input.permissionId,
          requestId: input.requestId,
          agent,
          requester,
          decider,
          tool,
          repository: input.repository,
          ...(card?.purpose === 'squire-spending' ? { purpose: 'squire-spending' } : {}),
          status: input.decision === 'allow' ? 'allowed' : 'denied',
        },
      });
    });
    return { messageId: id };
  }
  private async createWorkspace(input: Input<'createWorkspace'>, viewerId: string) {
    const id = input.workspaceId ?? randomUUID();
    await this.database.transaction(async (db) => {
      const inserted = await db.query(
        `INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [id, input.name],
      );
      if (!inserted.rowCount) {
        const owned = await db.query(
          `SELECT 1 FROM workspaces w JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL
           WHERE w.id=$1 AND m.identity_id=$2 AND m.role='owner' AND m.removed_at IS NULL`,
          [id, viewerId],
        );
        if (!owned.rowCount) throw new Error('workspaceId is invalid');
        return;
      }
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
        [id, viewerId],
      );
    });
    return { id };
  }
  private async updateWorkspace(input: Input<'updateWorkspace'>, viewerId: string) {
    await this.database.transaction(async (database) => {
      await this.requireWorkspaceManager(input.workspaceId, viewerId, database);
      const current = (
        await database.query<{ visibility: 'public' | 'invite-only' }>(
          'SELECT visibility FROM workspaces WHERE id=$1 FOR UPDATE',
          [input.workspaceId],
        )
      ).rows[0];
      const avatar =
        input.avatar === undefined
          ? null
          : await storeWorkspaceAvatar(
              database,
              input.workspaceId,
              viewerId,
              input.avatar,
              this.publicOrigin,
              this.objects
                ? (id, ownerId) => this.objects!.readOwnedBytes(ownerId, id, database)
                : undefined,
            );
      await database.query(
        `UPDATE workspaces SET name=COALESCE($2,name),avatar=COALESCE($3,avatar),visibility=COALESCE($4,visibility),updated_at=now() WHERE id=$1`,
        [input.workspaceId, input.name ?? null, avatar, input.visibility ?? null],
      );
      if (input.visibility && input.visibility !== current?.visibility) {
        const actor = await this.requireIdentity(viewerId, database);
        await workspaceSystemLine(database, {
          workspaceId: input.workspaceId,
          subject: identitySubject({ id: actor.pubkey, kind: actor.kind, name: actor.name }),
          verb: 'changed workspace visibility to',
          object: input.visibility,
          cardType: 'workspace-visibility',
          card: { visibility: input.visibility },
        });
      }
    });
  }
  private async leaveWorkspace(input: Input<'leaveWorkspace'>, viewerId: string) {
    const leaver = await this.requireIdentity(viewerId);
    await this.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      const current = (
        await database.query<{ role: 'owner' | 'admin' | 'member' | 'spectator' }>(
          `SELECT role FROM memberships
           WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL FOR UPDATE`,
          [input.workspaceId, viewerId],
        )
      ).rows[0];
      if (!current) return;
      if (current.role === 'owner') {
        const otherOwner = await database.query(
          `SELECT 1 FROM memberships
           WHERE workspace_id=$1 AND room_id IS NULL AND identity_id<>$2 AND role='owner' AND removed_at IS NULL`,
          [input.workspaceId, viewerId],
        );
        if (!otherOwner.rowCount) throw new Error('workspace manager cannot leave as sole owner');
      }
      await database.query(
        `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
        [input.workspaceId, viewerId],
      );
      await workspaceSystemLine(database, {
        workspaceId: input.workspaceId,
        subject: identitySubject({ id: leaver.pubkey, kind: leaver.kind, name: leaver.name }),
        verb: 'left',
        cardType: 'member-left',
        card: { identityId: viewerId },
      });
    });
  }
  /**
   * Deletes the workspace and everything in it — a real `DELETE FROM
   * workspaces`, not a flag. Owner-only. Idempotent: a retried or doubled
   * call on an already-deleted workspace resolves without effect.
   *
   * `rooms`/`memberships`/`agent_schedules`/`invites`/`agent_pairing_codes`/
   * `avatars`/`agent_grants` all carry `workspace_id ON DELETE CASCADE`, and
   * everything scoped by `room_id` (messages, corner_facts, agent_turns,
   * live_outputs, agent_commands, ...) chains through `rooms.workspace_id`'s
   * own cascade — so the single DELETE below empties the whole graph. Media
   * bytes are left for their existing TTL sweep (media-ttl.ts), same as
   * `deleteRoom`.
   *
   * Before the workspace disappears: an audit row survives it
   * (`workspace_deletions`, no FK back to the workspace), a notice row is
   * queued for every other human member so their next `readWorkspaces` can
   * tell them, and any agent whose only membership was here has its daemon
   * tokens revoked so its next daemon call is refused `agent_removed` — the
   * same terminal signal `removeAgent` uses, which the helper already
   * retires itself on (`retireRemovedAgent`/`isAgentRemovedError`).
   *
   * The idempotency floor (does the workspace still exist) runs BEFORE the
   * owner check, not after: a retried call must resolve quietly once the
   * workspace is gone even though the retrying identity's own `owner`
   * membership row went with it.
   */
  private async deleteWorkspace(input: Input<'deleteWorkspace'>, viewerId: string) {
    await this.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      const workspace = (
        await database.query<{ name: string }>(`SELECT name FROM workspaces WHERE id=$1`, [
          input.workspaceId,
        ])
      ).rows[0];
      if (!workspace) return; // idempotent: already deleted
      await this.requireWorkspaceOwner(input.workspaceId, viewerId, database);
      const members = await database.query<{ identity_id: string; kind: 'human' | 'agent' }>(
        `SELECT m.identity_id,i.kind FROM memberships m JOIN identities i ON i.id=m.identity_id
         WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL`,
        [input.workspaceId],
      );
      for (const member of members.rows) {
        if (member.identity_id === viewerId || member.kind !== 'human') continue;
        await database.query(
          `INSERT INTO workspace_deletion_notices(identity_id,workspace_id,workspace_name) VALUES ($1,$2,$3)`,
          [member.identity_id, input.workspaceId, workspace.name],
        );
      }
      const agentIds = members.rows.filter((m) => m.kind === 'agent').map((m) => m.identity_id);
      if (agentIds.length)
        await database.query(
          `UPDATE daemon_tokens SET revoked_at=now()
           WHERE agent_id=ANY($1) AND revoked_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM memberships m
               WHERE m.identity_id=daemon_tokens.agent_id AND m.removed_at IS NULL
                 AND m.workspace_id<>$2
             )`,
          [agentIds, input.workspaceId],
        );
      await database.query(
        `INSERT INTO workspace_deletions(workspace_id,workspace_name,deleted_by)
         VALUES ($1,$2,$3) ON CONFLICT (workspace_id) DO NOTHING`,
        [input.workspaceId, workspace.name, viewerId],
      );
      await database.query(`DELETE FROM workspaces WHERE id=$1`, [input.workspaceId]);
    });
  }
  private async createRoom(input: Input<'createRoom'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    const name = requireRoomSlug(input.name);
    const id = randomUUID();
    await this.database.transaction(async (db) => {
      await reserveRoomName(db, input.workspaceId, name);
      const repository =
        input.repositoryId === undefined
          ? undefined
          : (
              await db.query<{
                repository_id: string;
                installation_id: string;
                full_name: string;
                default_branch: string;
              }>(
                `SELECT r.repository_id,r.installation_id,r.full_name,r.default_branch
                 FROM github_repositories r
                 JOIN github_installations i USING(installation_id)
                 WHERE r.repository_id=$1 AND r.active AND i.owner_id=$2 AND i.status='active'`,
                [input.repositoryId, viewerId],
              )
            ).rows[0];
      if (input.repositoryId !== undefined && !repository)
        throw new Error('installed repository not found');
      await db.query(
        `INSERT INTO rooms(
           id,workspace_id,created_by,name,visibility,
           repository_key,repository_name,repository_remote,repository_target_branch,
           repository_updated_at,repository_resolution,github_installation_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          input.workspaceId,
          viewerId,
          name,
          input.visibility ?? 'public',
          repository ? `github:${repository.repository_id}` : null,
          repository?.full_name ?? null,
          repository ? `git://github.com/${repository.full_name}` : null,
          repository?.default_branch ?? 'main',
          repository ? new Date() : null,
          repository ? 'repository' : 'none',
          repository?.installation_id ?? null,
        ],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         SELECT $1,$2,$3,role FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$3 AND removed_at IS NULL`,
        [input.workspaceId, id, viewerId],
      );
      await joinWorkspaceMembersToPublicRoom(db, input.workspaceId, id);
    });
    return { id };
  }
  private async createHumanCorner(input: Input<'createHumanCorner'>, viewerId: string) {
    const title = normalizeHumanCornerTitle(input.title);
    const id = randomUUID();
    await this.database.transaction(async (database) => {
      const parent = (
        await database.query<{ workspace_id: string }>(
          `SELECT room.workspace_id FROM rooms room
           JOIN memberships room_member ON room_member.room_id=room.id
             AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           JOIN identities viewer ON viewer.id=$2 AND viewer.kind='human'
           WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL
           FOR SHARE OF room,room_member,workspace_member,viewer`,
          [input.roomId, viewerId],
        )
      ).rows[0];
      if (!parent) throw new Error('room access denied');
      if (input.appInstallationId) {
        const installed = await database.query(
          `SELECT 1 FROM corner_app_installations
           WHERE id=$1 AND workspace_id=$2 FOR SHARE`,
          [input.appInstallationId, parent.workspace_id],
        );
        if (!installed.rowCount) throw new Error('Corner App is not installed in this Workspace');
      }
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
         VALUES($1,$2,$3,$4,$5)`,
        [id, parent.workspace_id, input.roomId, viewerId, title],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
         SELECT workspace_id,$2,identity_id,role,event_subscriptions FROM memberships
         WHERE room_id=$1 AND removed_at IS NULL ON CONFLICT DO NOTHING`,
        [input.roomId, id],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'owner')
         ON CONFLICT(room_id,identity_id) WHERE room_id IS NOT NULL
         DO UPDATE SET role='owner',removed_at=NULL`,
        [parent.workspace_id, id, viewerId],
      );
      await database.query(
        `INSERT INTO corner_facts(corner_id,commissioned_by,objective,lane,kind,lifecycle)
         VALUES($1,$2,'','no_code','human','{"lifecycle":"working","checks":"unknown"}')`,
        [id, viewerId],
      );
      if (input.appInstallationId) {
        await database.query(
          `INSERT INTO corner_app_bindings(corner_id,installation_id,instance_id,bound_by)
           VALUES($1,$2,$3,$4)`,
          [id, input.appInstallationId, randomUUID(), viewerId],
        );
      }
    });
    this.live?.publish({ type: 'invalidate', roomId: input.roomId, reason: 'corner' });
    return { id };
  }
  private async renameCorner(roomId: string, name: string | undefined, viewerId: string) {
    const title = normalizeHumanCornerTitle(name);
    const parentId = await this.database.transaction(async (database) => {
      const access = (
        await database.query<{ parent_id: string; archived_at: Date | null }>(
          `SELECT room.parent_id, room.archived_at
           FROM rooms room
           JOIN memberships room_member ON room_member.room_id=room.id
             AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
           JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
             AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
             AND workspace_member.removed_at IS NULL
           JOIN identities viewer ON viewer.id=$2 AND viewer.kind='human'
           WHERE room.id=$1 AND room.parent_id IS NOT NULL
           FOR UPDATE OF room,room_member,workspace_member,viewer`,
          [roomId, viewerId],
        )
      ).rows[0];
      if (!access) throw new Error('room access denied');
      if (access.archived_at) throw new Error('room is archived');
      await database.query(`UPDATE rooms SET name=$2,updated_at=now() WHERE id=$1`, [
        roomId,
        title,
      ]);
      return access.parent_id;
    });
    this.live?.publish({ type: 'invalidate', roomId, reason: 'corner' });
    this.live?.publish({ type: 'invalidate', roomId: parentId, reason: 'corner' });
  }
  private async updateRoom(input: Input<'updateRoom'>, viewerId: string) {
    const existing = (
      await this.database.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM rooms WHERE id=$1`,
        [input.roomId],
      )
    ).rows[0];
    if (!existing) throw new Error('room not found');
    if (existing.parent_id) {
      if (input.visibility !== undefined || input.reviewerAgentId !== undefined) {
        throw new Error('room lifecycle cannot target a corner');
      }
      await this.renameCorner(input.roomId, input.name, viewerId);
      return;
    }
    const room = await this.requireTopLevelRoom(input.roomId);
    await this.requireWorkspaceManager(room.workspace_id, viewerId);
    const name = input.name === undefined ? undefined : requireRoomSlug(input.name);
    await this.database.transaction(async (database) => {
      if (name !== undefined)
        await reserveRoomName(database, room.workspace_id, name, input.roomId);
      const current = (
        await database.query<{
          visibility: 'public' | 'invite-only';
          reviewer_agent_id: string | null;
        }>('SELECT visibility,reviewer_agent_id FROM rooms WHERE id=$1 FOR UPDATE', [input.roomId])
      ).rows[0];
      if (input.reviewerAgentId !== undefined && input.reviewerAgentId !== null) {
        const reviewer = await database.query(
          `SELECT 1
           FROM memberships membership
           JOIN identities identity ON identity.id=membership.identity_id AND identity.kind='agent'
           WHERE membership.room_id=$1 AND membership.identity_id=$2
             AND membership.removed_at IS NULL
           FOR SHARE OF membership`,
          [input.roomId, input.reviewerAgentId],
        );
        if (!reviewer.rowCount) throw new Error('reviewer agent Room membership required');
      }
      await database.query(
        `UPDATE rooms
         SET name=COALESCE($2,name),visibility=COALESCE($3,visibility),
             reviewer_agent_id=CASE WHEN $4::boolean THEN $5 ELSE reviewer_agent_id END,
             updated_at=now()
         WHERE id=$1`,
        [
          input.roomId,
          name ?? null,
          input.visibility ?? null,
          input.reviewerAgentId !== undefined,
          input.reviewerAgentId ?? null,
        ],
      );
      if (
        input.reviewerAgentId !== undefined &&
        input.reviewerAgentId !== current?.reviewer_agent_id
      ) {
        if (current?.reviewer_agent_id)
          await database.query(
            `UPDATE memberships member
             SET event_subscriptions=member.event_subscriptions-'check-passed'
             FROM rooms room
             WHERE member.room_id=room.id AND member.identity_id=$2
               AND member.removed_at IS NULL
               AND (room.id=$1 OR room.parent_id=$1)`,
            [input.roomId, current.reviewer_agent_id],
          );
        if (input.reviewerAgentId)
          await database.query(
            `UPDATE memberships member
             SET event_subscriptions=CASE
               WHEN member.event_subscriptions @> '["check-passed"]'::jsonb
                 THEN member.event_subscriptions
               ELSE member.event_subscriptions||'["check-passed"]'::jsonb
             END
             FROM rooms room
             WHERE member.room_id=room.id AND member.identity_id=$2
               AND member.removed_at IS NULL
               AND (room.id=$1 OR room.parent_id=$1)`,
            [input.roomId, input.reviewerAgentId],
          );
      }
      if (input.reviewerAgentId !== undefined)
        await reconcileConfiguredCornerReviewers(database, input.roomId);
      if (input.visibility && input.visibility !== current?.visibility) {
        if (input.visibility === 'public')
          await joinWorkspaceMembersToPublicRoom(database, room.workspace_id, input.roomId);
        const actor = await this.requireIdentity(viewerId, database);
        await systemLine(database, {
          roomId: input.roomId,
          subject: identitySubject({ id: actor.pubkey, kind: actor.kind, name: actor.name }),
          verb: 'changed room visibility to',
          object: input.visibility,
          cardType: 'room-visibility',
          card: { visibility: input.visibility },
        });
      }
    });
  }
  private async deleteRoom(roomId: string, viewerId: string) {
    const room = await this.requireTopLevelRoom(roomId);
    await this.requireWorkspaceManager(room.workspace_id, viewerId);
    await this.database.query(`DELETE FROM rooms WHERE id=$1`, [roomId]);
  }
  private async leaveRoom(roomId: string, viewerId: string) {
    const room = await this.requireTopLevelRoom(roomId);
    const leaver = await this.requireIdentity(viewerId);
    await this.database.transaction(async (database) => {
      const membership = (
        await database.query<{ workspace_role: 'owner' | 'admin' | 'member' | 'spectator' }>(
          `SELECT workspace_member.role workspace_role
           FROM memberships room_member
           JOIN memberships workspace_member
             ON workspace_member.workspace_id=$3 AND workspace_member.room_id IS NULL
            AND workspace_member.identity_id=room_member.identity_id
            AND workspace_member.removed_at IS NULL
           WHERE room_member.room_id=$1 AND room_member.identity_id=$2
             AND room_member.removed_at IS NULL
           FOR UPDATE OF room_member,workspace_member`,
          [roomId, viewerId, room.workspace_id],
        )
      ).rows[0];
      if (!membership) throw new Error('room membership required');
      if (membership.workspace_role === 'owner' || membership.workspace_role === 'admin') {
        throw new Error('workspace managers cannot leave Rooms');
      }
      await database.query(
        `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
        [roomId, viewerId],
      );
      await systemLine(database, {
        roomId,
        subject: identitySubject({ id: leaver.pubkey, kind: leaver.kind, name: leaver.name }),
        verb: 'left',
        cardType: 'member-left',
        card: { identityId: viewerId },
      });
    });
  }
  private async closeChat(roomId: string, viewerId: string) {
    await this.database.transaction(async (database) => {
      const membership = await database.query(
        `SELECT 1 FROM rooms room
         JOIN memberships membership ON membership.room_id=room.id
           AND membership.identity_id=$2 AND membership.removed_at IS NULL
         WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL
           AND room.direct_participants IS NOT NULL
         FOR SHARE OF room,membership`,
        [roomId, viewerId],
      );
      if (!membership.rowCount) throw new Error('direct-message membership required');
      await database.query(
        `INSERT INTO chat_dismissals(room_id,identity_id,dismissed_at) VALUES($1,$2,now())
         ON CONFLICT (room_id,identity_id)
         DO UPDATE SET dismissed_at=EXCLUDED.dismissed_at`,
        [roomId, viewerId],
      );
    });
  }
  private async reopenChat(roomId: string, viewerId: string) {
    await this.database.transaction(async (database) => {
      await this.requireTopLevelChatMember(roomId, viewerId, database);
      await database.query(`DELETE FROM chat_dismissals WHERE room_id=$1 AND identity_id=$2`, [
        roomId,
        viewerId,
      ]);
    });
  }
  private async addRoomMember(input: Input<'addRoomMember'>, viewerId: string) {
    const room = await this.requireTopLevelRoom(input.roomId);
    await this.requireWorkspaceManager(room.workspace_id, viewerId);
    const workspaceMember = await this.database.query(
      `SELECT 1 FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [room.workspace_id, input.memberId],
    );
    if (!workspaceMember.rowCount) throw new Error('workspace membership required');
    const result = await joinRooms(this.database, {
      workspaceId: room.workspace_id,
      identityId: input.memberId,
      invitedById: viewerId,
      rooms: { type: 'rooms', roomIds: [input.roomId] },
    });
    return { joined: result.roomIds.length > 0 };
  }
  private async removeRoomMember(input: Input<'removeRoomMember'>, viewerId: string) {
    const room = await this.requireTopLevelRoom(input.roomId);
    await this.requireWorkspaceManager(room.workspace_id, viewerId);
    const target = await this.database.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [input.roomId, input.memberId],
    );
    if (!target.rowCount) throw new Error('room membership required');
    if (input.memberId === viewerId) throw new Error('room managers cannot remove themselves');
    const remover = await this.requireIdentity(viewerId);
    const removed = await this.requireIdentity(input.memberId);
    await this.database.transaction(async (database) => {
      await database.query(
        `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
        [input.roomId, input.memberId],
      );
      await systemLine(database, {
        roomId: input.roomId,
        subject: identitySubject({ id: remover.pubkey, kind: remover.kind, name: remover.name }),
        verb: 'removed',
        object: { text: removed.name, id: removed.pubkey },
        cardType: 'member-removed',
        card: { identityId: input.memberId },
      });
    });
  }
  private async addWorkspaceMember(input: Input<'addWorkspaceMember'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    if (input.memberId === viewerId) throw new Error('workspace managers cannot change themselves');
    const changedMember = await this.requireIdentity(input.memberId);
    const changingMember = await this.requireIdentity(viewerId);
    return this.database.transaction(async (database) => {
      const workspaceIds = await lockIdentityHandleWorkspaces(database, input.memberId, [
        input.workspaceId,
      ]);
      const targetIdentity = (
        await database.query<{ handle: string | null; kind: 'human' | 'agent'; name: string }>(
          `SELECT handle,kind,name FROM identities WHERE id=$1 FOR UPDATE`,
          [input.memberId],
        )
      ).rows[0];
      if (!targetIdentity) throw new Error('identity not found');
      const roles = await database.query<{
        identity_id: string;
        role: 'owner' | 'admin' | 'member' | 'spectator';
        removed_at: Date | null;
      }>(
        `SELECT identity_id,role,removed_at FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id IN ($2,$3) FOR UPDATE`,
        [input.workspaceId, viewerId, input.memberId],
      );
      const actor = roles.rows.find((row) => row.identity_id === viewerId);
      const target = roles.rows.find((row) => row.identity_id === input.memberId);
      if (!actor || actor.removed_at || (actor.role !== 'owner' && actor.role !== 'admin')) {
        throw new Error('workspace manager required');
      }
      if (
        target?.role === 'owner' ||
        (actor.role === 'admin' && (input.role === 'owner' || target?.role === 'admin'))
      ) {
        throw new Error('workspace manager cannot change a member with equal or greater authority');
      }
      if (targetIdentity.kind === 'human')
        await reassignCollidingAgentHandles(
          database,
          input.memberId,
          targetIdentity.handle,
          workspaceIds,
        );
      else {
        const handle = await this.availableAgentHandle(
          database,
          input.workspaceId,
          input.memberId,
          targetIdentity.name,
          Promise.resolve(workspaceIds),
        );
        await database.query(`UPDATE identities SET handle=$2,updated_at=now() WHERE id=$1`, [
          input.memberId,
          handle,
        ]);
      }
      if (target) {
        await database.query(
          `UPDATE memberships SET role=$3,removed_at=NULL,invited_by=CASE WHEN removed_at IS NOT NULL THEN $4 ELSE invited_by END
           WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
          [input.workspaceId, input.memberId, input.role, viewerId],
        );
        await syncTopLevelSharedRoomRoles(database, input.workspaceId, input.memberId);
        if (!target.removed_at && target.role !== input.role) {
          const targetMention = systemIdentityMention({
            id: changedMember.pubkey,
            kind: changedMember.kind,
            name: changedMember.name,
            handle: changedMember.handle ?? null,
          });
          await workspaceSystemLine(database, {
            workspaceId: input.workspaceId,
            subject: identitySubject({
              id: changingMember.pubkey,
              kind: changingMember.kind,
              name: changingMember.name,
            }),
            verb: 'changed',
            object: targetMention
              ? `${targetMention}'s role to ${input.role}`
              : `role to ${input.role}`,
            cardType: 'member-role',
            card: { identityId: input.memberId, role: input.role },
          });
        }
        if (target.removed_at)
          await joinRooms(database, {
            workspaceId: input.workspaceId,
            identityId: input.memberId,
            invitedById: viewerId,
            rooms: { type: 'all-live-top-level' },
            workspaceJoined: true,
          });
        return { joined: target.removed_at !== null };
      }
      const inserted = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
         VALUES($1,NULL,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [input.workspaceId, input.memberId, input.role, viewerId],
      );
      if (inserted.rowCount)
        await joinRooms(database, {
          workspaceId: input.workspaceId,
          identityId: input.memberId,
          invitedById: viewerId,
          rooms: { type: 'all-live-top-level' },
          workspaceJoined: true,
        });
      return { joined: inserted.rowCount > 0 };
    });
  }
  private async setWorkspaceBan(
    input: Input<'banWorkspaceMember'>,
    viewerId: string,
    banned: boolean,
  ) {
    if (input.memberId === viewerId) throw new Error('workspace managers cannot ban themselves');
    await this.database.transaction(async (database) => {
      await database.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      await database.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text || $2::text, 0))`,
        [input.workspaceId, input.memberId],
      );
      const roles = await database.query<{
        identity_id: string;
        role: string;
        removed_at: Date | null;
      }>(
        `SELECT identity_id,role,removed_at FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id IN ($2,$3) FOR UPDATE`,
        [input.workspaceId, viewerId, input.memberId],
      );
      const actor = roles.rows.find((row) => row.identity_id === viewerId);
      const target = roles.rows.find((row) => row.identity_id === input.memberId);
      if (!actor || actor.removed_at || !['owner', 'admin'].includes(actor.role))
        throw new Error('workspace manager required');
      if (!target) throw new Error('workspace membership required');
      if (target.role === 'owner' || (actor.role === 'admin' && target.role === 'admin'))
        throw new Error('workspace manager cannot ban a member with equal or greater authority');
      if (banned) {
        await database.query(
          `INSERT INTO workspace_bans(workspace_id,identity_id,banned_by)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [input.workspaceId, input.memberId, viewerId],
        );
        await database.query(
          `UPDATE memberships SET removed_at=COALESCE(removed_at,now())
          WHERE workspace_id=$1 AND identity_id=$2`,
          [input.workspaceId, input.memberId],
        );
      } else {
        await database.query(
          `DELETE FROM workspace_bans WHERE workspace_id=$1 AND identity_id=$2`,
          [input.workspaceId, input.memberId],
        );
      }
    });
  }

  /**
   * A manager removes a person from the Workspace. Admins may remove peers;
   * owners remain protected. Every live Room membership goes with the
   * Workspace one and each of those Rooms carries the removal line. Agents
   * are not people — their removal is the removeAgent host teardown.
   */
  private async removeWorkspaceMember(input: Input<'removeWorkspaceMember'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    if (input.memberId === viewerId) throw new Error('workspace managers cannot remove themselves');
    const remover = await this.requireIdentity(viewerId);
    const removed = await this.requireIdentity(input.memberId);
    if (removed.kind !== 'human')
      throw new Error('invalid member: agents are removed through removeAgent');
    await this.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      const roles = await database.query<{
        identity_id: string;
        role: 'owner' | 'admin' | 'member' | 'spectator';
      }>(
        `SELECT identity_id,role FROM memberships
         WHERE workspace_id=$1 AND room_id IS NULL AND identity_id IN ($2,$3) AND removed_at IS NULL
         FOR UPDATE`,
        [input.workspaceId, viewerId, input.memberId],
      );
      const actor = roles.rows.find((row) => row.identity_id === viewerId);
      const target = roles.rows.find((row) => row.identity_id === input.memberId);
      if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
        throw new Error('workspace manager required');
      }
      if (!target) throw new Error('workspace membership required');
      if (target.role === 'owner') {
        throw new Error('workspace manager cannot remove an owner');
      }
      await database.query(
        `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
        [input.workspaceId, input.memberId],
      );
      await workspaceSystemLine(database, {
        workspaceId: input.workspaceId,
        subject: identitySubject({ id: remover.pubkey, kind: remover.kind, name: remover.name }),
        verb: 'removed',
        object: { text: removed.name, id: removed.pubkey },
        cardType: 'member-removed',
        card: { identityId: input.memberId },
      });
    });
  }
  private async resolveDirectMessage(input: Input<'resolveDirectMessage'>, viewerId: string) {
    const participants = [viewerId, input.participantId].sort();
    if (participants[0] === participants[1]) throw new Error('direct message requires two members');
    const members = await this.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id IN ($2,$3) AND removed_at IS NULL`,
      [input.workspaceId, participants[0], participants[1]],
    );
    if (new Set(members.rows.map((row) => row.identity_id)).size !== 2) {
      throw new Error('workspace membership required for direct messages');
    }
    const found = await this.database.query<{ id: string }>(
      `SELECT id FROM rooms WHERE workspace_id=$1 AND direct_participants=$2::jsonb`,
      [input.workspaceId, JSON.stringify(participants)],
    );
    if (found.rows[0]) {
      await this.database.query(`DELETE FROM chat_dismissals WHERE room_id=$1 AND identity_id=$2`, [
        found.rows[0].id,
        viewerId,
      ]);
      return { id: found.rows[0].id, created: false };
    }
    const id = directMessageRoomId(input.workspaceId, participants as [string, string]);
    const created = await this.database.transaction(async (db) => {
      const inserted = await db.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
         VALUES($1,$2,$3,'Direct message','invite-only',$4::jsonb) ON CONFLICT DO NOTHING`,
        [id, input.workspaceId, viewerId, JSON.stringify(participants)],
      );
      if (!inserted.rowCount) return false;
      for (const member of participants)
        await db.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
          [input.workspaceId, id, member],
        );
      return true;
    });
    return { id, created };
  }
  private async createInvite(input: Input<'createInvite'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    const value = createCommunityInviteToken(randomBytes(32));
    const expiresAt = Date.now() + 7 * 86400_000;
    await this.database.query(
      `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at) VALUES($1,$2,$3,$4)`,
      [hash(value), input.workspaceId, viewerId, new Date(expiresAt)],
    );
    return { token: value, expiresAt: Math.floor(expiresAt / 1000) };
  }
  private async redeemInvite(input: Input<'redeemInvite'>, viewerId: string) {
    if (!isCommunityInviteToken(input.token)) throw new Error('invalid invite token');
    const result = await this.database.query<{
      workspace_id: string;
      created_by: string;
      already_joined: boolean;
    }>(
      `SELECT i.workspace_id,i.created_by,
         EXISTS(SELECT 1 FROM memberships joined
           WHERE joined.workspace_id=i.workspace_id AND joined.room_id IS NULL
             AND joined.identity_id=$2 AND joined.removed_at IS NULL) already_joined
       FROM invites i
       JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
         AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
       WHERE i.token_hash=$1 AND i.expires_at>now()`,
      [hash(input.token), viewerId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('invite not found');
    if (row.already_joined) return { joined: false, workspaceId: row.workspace_id };
    return this.database.transaction(async (database) => {
      const workspaceIds = await lockIdentityHandleWorkspaces(database, viewerId, [
        row.workspace_id,
      ]);
      const identity = (
        await database.query<{ handle: string | null }>(
          `SELECT handle FROM identities WHERE id=$1 FOR UPDATE`,
          [viewerId],
        )
      ).rows[0];
      if (!identity) throw new Error('identity not found');
      await reassignCollidingAgentHandles(database, viewerId, identity.handle, workspaceIds);
      const joined = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by) VALUES($1,NULL,$2,'member',$3)
         ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET role='member',removed_at=NULL,invited_by=EXCLUDED.invited_by
           WHERE memberships.removed_at IS NOT NULL`,
        [row.workspace_id, viewerId, row.created_by],
      );
      await joinRooms(database, {
        workspaceId: row.workspace_id,
        identityId: viewerId,
        invitedById: row.created_by,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: joined.rowCount > 0,
      });
      return { joined: joined.rowCount > 0, workspaceId: row.workspace_id };
    });
  }
  private async createPairing(input: Input<'createAgentPairingCode'>, viewerId: string) {
    await this.requireWorkspaceMember(input.workspaceId, viewerId);
    const code = createAgentPairingCode(randomBytes(8));
    const expiresAt = Date.now() + 15 * 60_000;
    await this.database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at) VALUES($1,$2,$3,$4)`,
      [hash(code), input.workspaceId, viewerId, new Date(expiresAt)],
    );
    return { code, expiresAt: Math.floor(expiresAt / 1000) };
  }
  private async updateAgentSoul(input: Input<'updateAgentSoul'>, viewerId: string) {
    await this.requireWorkspaceAgent(input.workspaceId, input.agentId, viewerId);
    const name = normalizeAgentName(input.name);
    await this.database.transaction(async (database) => {
      const handle = await this.availableAgentHandle(
        database,
        input.workspaceId,
        input.agentId,
        name,
      );
      await database.query(`UPDATE agents SET soul=$2::jsonb,updated_at=now() WHERE agent_id=$1`, [
        input.agentId,
        JSON.stringify({
          name,
          instructions: input.instructions,
          avatarSeed: input.avatarSeed,
          ...(input.avatar ? { avatar: input.avatar } : {}),
        }),
      ]);
      await database.query(
        `UPDATE identities SET name=$2,handle=$3,avatar=COALESCE((SELECT '/v1/agent-avatars/'||id::text FROM agent_avatars WHERE agent_id=$1),$4,avatar),updated_at=now() WHERE id=$1`,
        [input.agentId, name, handle, input.avatar ?? null],
      );
    });
  }
  private async updateAgentModel(input: Input<'updateAgentModelSelection'>, viewerId: string) {
    await this.requireWorkspaceAgent(input.workspaceId, input.agentId, viewerId);
    const hasModel = Object.prototype.hasOwnProperty.call(input, 'model');
    const hasEffort = Object.prototype.hasOwnProperty.call(input, 'effort');
    await this.database.transaction(async (database) => {
      const context = (
        await database.query<{
          selected_model: string | null;
          selected_effort: string | null;
          model_catalog: AgentDetailView['catalog'];
          agent_id: string;
          agent_kind: 'human' | 'agent';
          agent_name: string;
          agent_handle: string | null;
          actor_id: string;
          actor_kind: 'human' | 'agent';
          actor_name: string;
          actor_handle: string | null;
        }>(
          `SELECT config.selected_model,config.selected_effort,config.model_catalog,
                  agent.id agent_id,agent.kind agent_kind,agent.name agent_name,agent.handle agent_handle,
                  actor.id actor_id,actor.kind actor_kind,actor.name actor_name,actor.handle actor_handle
           FROM agents config JOIN identities agent ON agent.id=config.agent_id
           JOIN identities actor ON actor.id=$2 WHERE config.agent_id=$1 FOR UPDATE`,
          [input.agentId, viewerId],
        )
      ).rows[0];
      if (!context) throw new Error('agent not found');
      if (hasModel && input.model) {
        const axis = context.model_catalog.find((candidate) => candidate.category === 'model');
        if (!axis?.options.some((choice) => choice.id === input.model)) {
          throw new Error('model is not available in the live harness catalog');
        }
      }
      if (hasEffort && input.effort) {
        const axis = context.model_catalog.find((candidate) => candidate.category !== 'model');
        if (!axis?.options.some((choice) => choice.id === input.effort)) {
          throw new Error('effort is not available in the live harness catalog');
        }
      }
      await database.query(
        `UPDATE agents
         SET selected_model=CASE WHEN $2 THEN $3 ELSE selected_model END,
             selected_effort=CASE WHEN $4 THEN $5 ELSE selected_effort END,
             updated_at=now()
         WHERE agent_id=$1`,
        [input.agentId, hasModel, input.model ?? null, hasEffort, input.effort ?? null],
      );
      const changes: Array<{ axis: 'model' | 'effort'; value: string | null }> = [];
      if (hasModel && (input.model ?? null) !== context.selected_model)
        changes.push({ axis: 'model', value: input.model ?? null });
      if (hasEffort && (input.effort ?? null) !== context.selected_effort)
        changes.push({ axis: 'effort', value: input.effort ?? null });
      if (!changes.length) return;
      const rooms = await database.query<{ room_id: string }>(
        `SELECT membership.room_id FROM memberships membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1 AND membership.workspace_id=$2
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`,
        [input.agentId, input.workspaceId],
      );
      const actor = {
        id: context.actor_id,
        kind: context.actor_kind,
        name: context.actor_name,
        handle: context.actor_handle,
      };
      // Hot-restart wake: every daemon live subscription of these Rooms filters
      // on the target agent, so its retained sessions retire at once and the
      // next turn cold-activates against the saved selection — exactly what
      // session start reads. A change that wrote nothing sends no wake, and a
      // plain reconnect never sees one. The direct pg_notify rides this same
      // transaction (delivered on commit, dropped on rollback) to every server
      // machine's live listener, since the agents table carries no Room for a
      // row trigger to name.
      for (const room of rooms.rows) {
        await database.query(`SELECT pg_notify($1, $2)`, [
          POSTGRES_LIVE_CHANNEL,
          JSON.stringify({
            table: 'agent_config',
            operation: 'UPDATE',
            roomId: room.room_id,
            agentId: input.agentId,
          }),
        ]);
      }
      const agentMention = systemIdentityMention({
        id: context.agent_id,
        kind: context.agent_kind,
        name: context.agent_name,
        handle: context.agent_handle,
      });
      // A model/effort change is a Workspace-scoped configuration fact, not
      // Room activity: one fact routed through workspaceSystemLine into each
      // person's @system DM, the same lane as role and visibility changes.
      for (const change of changes) {
        const value =
          change.axis === 'model' && change.value
            ? selectedModelLabel(change.value, context.model_catalog ?? [])
            : change.value;
        await workspaceSystemLine(database, {
          workspaceId: input.workspaceId,
          subject: identitySubject(actor),
          verb: 'changed',
          object: `${agentMention}'s ${change.axis} to ${value ?? 'default'}`,
          cardType: 'agent-model',
          card: { agentId: input.agentId, axis: change.axis, value },
        });
      }
    });
  }
  private async refreshAgentModelCatalog(
    input: Input<'refreshAgentModelCatalog'>,
    viewerId: string,
  ) {
    await this.requireWorkspaceAgent(input.workspaceId, input.agentId, viewerId);
    await this.database.transaction(async (database) => {
      // Empty the stale snapshot first. A successful daemon probe replaces it;
      // a failed probe therefore cannot leave the phone offering choices for
      // the wrong model.
      await database.query(
        `UPDATE agents SET model_catalog='[]'::jsonb,updated_at=now() WHERE agent_id=$1`,
        [input.agentId],
      );
      const rooms = await database.query<{ room_id: string }>(
        `SELECT membership.room_id FROM memberships membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1 AND membership.workspace_id=$2
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`,
        [input.agentId, input.workspaceId],
      );
      for (const room of rooms.rows) {
        await database.query(`SELECT pg_notify($1, $2)`, [
          POSTGRES_LIVE_CHANNEL,
          JSON.stringify({
            table: 'agent_config',
            operation: 'UPDATE',
            roomId: room.room_id,
            agentId: input.agentId,
          }),
        ]);
      }
    });
  }
  /**
   * Repository grants require a Workspace manager; personal resources require
   * their owner. Authority is checked here, never entrusted to the phone. The
   * decision settles the card in place and posts one system line mentioning
   * the agent so its daemon wakes and resumes the paused turn.
   */
  private async decideAgentGrant(input: Input<'decideAgentGrant'>, viewerId: string) {
    const decision: AgentGrantDecision | undefined =
      input.decision === 'always' || input.decision === 'once' || input.decision === 'deny'
        ? input.decision
        : undefined;
    if (!decision) throw new Error('grant decision is invalid');
    const grant = await this.requireGrantAuthority(input.grantId, viewerId);
    if (grant.status !== 'pending') throw new Error('grant decision conflict: already decided');
    // Existing pending Squire cards may still live in the source Room. Find
    // the card by its exact grant id so an upgrade settles either placement.
    const cardRoomId =
      (
        await this.database.query<{ room_id: string }>(
          `SELECT message.room_id FROM messages message
         JOIN rooms room ON room.id=message.room_id
         WHERE room.workspace_id=$2 AND message.card_type='grant-request'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(message.card->'grants') entry
             WHERE entry->>'grantId'=$1
           )
         ORDER BY message.created_at DESC,message.id DESC LIMIT 1`,
          [input.grantId, grant.workspace_id],
        )
      ).rows[0]?.room_id ?? grant.room_id;
    const status: AgentGrantStatus =
      decision === 'always' ? 'approved' : decision === 'once' ? 'once' : 'denied';
    const decider = await this.requireIdentity(viewerId);
    await this.database.transaction(async (database) => {
      const updated = await database.query<{ decided_at: Date }>(
        `UPDATE agent_grants SET status=$2,decided_by=$3,decided_at=now()
         WHERE id::text=$1 AND status='pending' RETURNING decided_at`,
        [input.grantId, status, viewerId],
      );
      const decidedAt = updated.rows[0]?.decided_at;
      if (!decidedAt) throw new Error('grant decision conflict: already decided');
      await this.settleGrantCard(database, {
        roomId: cardRoomId,
        grantId: input.grantId,
        status,
        decidedBy: decider,
        decidedAt,
      });
      // The text this composes is exactly `formatGrantDecisionLine`'s shape
      // (`<decider> approved command npm test`): the daemon recognises the
      // owner's answer structurally with `parseGrantDecisionLine`, and the
      // mention on a freshly-inserted row is what wakes it (a settled card's
      // own JSONB update carries no mention and would not be seen as new).
      // C101: kept deliberately for that wake, but never rendered — the
      // settled card above already carries the same answer for a human
      // reader, so this row is excluded from every phone-visible transcript
      // query (`roomMessages`/`messageRows`) by its card_type.
      await systemLine(database, {
        roomId: grant.room_id,
        authorId: viewerId,
        subject: identitySubject({ id: decider.pubkey, kind: decider.kind, name: decider.name }),
        verb:
          decision === 'always' ? 'approved' : decision === 'once' ? 'approved once' : 'declined',
        // A resume kind: it answers a turn already paused on the ask, and must
        // never start a second one (`RESUME_KINDS`).
        kind: 'grant-decided',
        commandId: (
          await database.query<{ command_id: string }>(
            `SELECT command_id FROM agent_grants WHERE id=$1`,
            [input.grantId],
          )
        ).rows[0]?.command_id,
        object: `${grant.kind} ${grant.target}`,
        wakes: [grant.agent_id],
        cardType: 'grant-decision',
        card: { grantId: input.grantId, status },
      });
    });
    if (cardRoomId !== grant.room_id)
      this.live?.publish({ type: 'invalidate', roomId: cardRoomId, reason: 'grant' });
    return { grantId: input.grantId, status, roomId: grant.room_id };
  }
  /** Revoke is one tap on the profile; a command rule stops matching at once. */
  private async revokeAgentGrant(input: Input<'revokeAgentGrant'>, viewerId: string) {
    const grant = await this.requireGrantAuthority(input.grantId, viewerId);
    // The profile shows who revoked it and when, in the same two columns.
    const revoked = await this.database.query(
      `UPDATE agent_grants SET status='revoked',decided_by=$2,decided_at=now()
       WHERE id::text=$1 AND status IN ('approved','once')`,
      [input.grantId, viewerId],
    );
    if (!revoked.rowCount) throw new Error('grant revoke conflict: grant is not active');
    return { grantId: input.grantId, status: 'revoked' as const, roomId: grant.room_id };
  }
  private async createRoomPoll(input: Input<'createRoomPoll'>, viewerId: string) {
    if (!(await this.hasRoomAccess(input.roomId, viewerId))) throw new Error('room access denied');
    await this.assertRoomIsWritable(input.roomId, viewerId);
    const identity = await this.database.query<{ kind: string }>(
      `SELECT kind FROM identities WHERE id=$1`,
      [viewerId],
    );
    if (identity.rows[0]?.kind !== 'human') throw new Error('poll creator must be human');
    return this.database.transaction(async (database) => {
      const result = await postRoomChoice(database, {
        roomId: input.roomId,
        agentId: viewerId,
        mode: 'poll',
        prompt: input.prompt,
        options: input.options,
        ttlSeconds: input.ttlSeconds,
      });
      return {
        choiceId: result.choiceId,
        messageId: result.messageId,
        roomId: input.roomId,
        closesAt: result.closesAt!,
      };
    });
  }
  private async answerChoice(input: Input<'answerChoice'>, viewerId: string) {
    return this.database.transaction((database) =>
      answerRoomChoice(database, {
        choiceId: input.choiceId,
        optionId: input.optionId,
        viewerId,
      }),
    );
  }
  private async skipChoice(input: Input<'skipChoice'>, viewerId: string) {
    return this.database.transaction((database) =>
      skipRoomChoice(database, { choiceId: input.choiceId, viewerId }),
    );
  }
  /**
   * Settle one grant's line inside the card the Room already shows. The card
   * is what the phone renders its ALWAYS/ONCE/NO buttons from, so a rule that
   * has been decided — or revoked out from under a retired agent — must stop
   * offering a choice that can no longer be taken. Lines the card has already
   * settled are left exactly as they are.
   */
  private async settleGrantCard(
    database: SqlDatabase,
    input: {
      roomId: string;
      grantId: string;
      status: AgentGrantStatus;
      decidedBy: RoomViewIdentity;
      decidedAt: Date;
    },
  ) {
    const card = (
      await database.query<{ id: string; card: { grants: AgentGrantView[] } }>(
        `SELECT id,card FROM messages
         WHERE room_id=$1 AND card_type='grant-request'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(card->'grants') entry WHERE entry->>'grantId'=$2
           )
         ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [input.roomId, input.grantId],
      )
    ).rows[0];
    if (!card) return;
    const grants = card.card.grants.map((entry) =>
      entry.grantId === input.grantId && entry.status === 'pending'
        ? {
            ...entry,
            status: input.status,
            decidedBy: input.decidedBy,
            decidedAt: unix(input.decidedAt),
          }
        : entry,
    );
    await database.query(
      `UPDATE messages SET card=jsonb_set(card,'{grants}',$2::jsonb) WHERE id=$1`,
      [card.id, JSON.stringify(grants)],
    );
  }
  private async requireGrantAuthority(grantId: unknown, viewerId: string) {
    if (typeof grantId !== 'string' || !grantId) throw new Error('grantId is required');
    const grant = (
      await this.database.query<{
        agent_id: string;
        workspace_id: string;
        room_id: string;
        kind: AgentGrantView['kind'];
        target: string;
        status: AgentGrantStatus;
        owner_id: string;
      }>(
        `SELECT g.agent_id,g.workspace_id,g.room_id,g.kind,g.target,g.status,a.owner_id
         FROM agent_grants g JOIN agents a ON a.agent_id=g.agent_id WHERE g.id::text=$1`,
        [grantId],
      )
    ).rows[0];
    if (!grant) throw new Error('grant not found');
    if (grant.kind !== 'repository') {
      if (grant.owner_id !== viewerId) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
      const member = await this.database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL`,
        [grant.workspace_id, viewerId],
      );
      if (!member.rowCount) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
      return grant;
    }
    const manager = await this.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2
       AND role IN ('owner','admin') AND removed_at IS NULL`,
      [grant.workspace_id, viewerId],
    );
    if (!manager.rowCount)
      throw new Error('repository approval access denied: requires a workspace owner or admin');
    return grant;
  }
  /**
   * Start the connector offer's full sign-in ceremony. Authorization is
   * the captain's Q4 answer, decided here and never on the phone: the person
   * the agent ADDRESSED — whose keys the tool will hold — or a current
   * Workspace manager, who already owns Workspace configuration. Nobody else
   * can act on the card, whatever the phone shows.
   *
   * Starting the ceremony is configuration, not authority: it pairs the connector on the
   * OFFERING agent's machine through the very row the Workbench page's own
   * Connect writes (`armConnectorPairing`). Adapted kinds still require the
   * acceptor to own that helper, so a foreign Workbench cannot inherit its
   * vault. Every later credential use goes through the connector's unchanged
   * receipts and approvals, and the vault stays write-only. The card remains
   * `connecting`; the helper's connected report settles it and emits the hidden
   * resume line.
   */
  private async acceptConnectorOffer(
    input: Input<'acceptConnectorOffer'>,
    viewerId: string,
  ): Promise<Output<'acceptConnectorOffer'>> {
    if (typeof input.offerId !== 'string' || !input.offerId) throw new Error('offerId is required');
    const offer = (
      await this.database.query<{
        id: string;
        agent_id: string;
        workspace_id: string;
        room_id: string;
        addressee_id: string;
        connector_type: string;
        machine_id: string;
        status: ConnectorOfferStatus;
        accepted_by: string | null;
        accepted_at: Date | null;
      }>(
        `SELECT id,agent_id,workspace_id,room_id,addressee_id,connector_type,machine_id,status,
                accepted_by,accepted_at
         FROM connector_offers WHERE id::text=$1`,
        [input.offerId],
      )
    ).rows[0];
    if (!offer) throw new Error('connector offer not found');
    if (offer.status === 'accepted') throw new Error('connector offer conflict: already accepted');
    if (!isOfferableConnectorKind(offer.connector_type))
      throw new Error(`connector offer is invalid: ${offer.connector_type} cannot be added`);
    const connectorType: ConnectorKind = offer.connector_type;
    if (offer.addressee_id !== viewerId) {
      const manager = await this.database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2
           AND role IN ('owner','admin') AND removed_at IS NULL`,
        [offer.workspace_id, viewerId],
      );
      if (!manager.rowCount) throw new Error(CONNECTOR_OFFER_AUTHORITY_MESSAGE);
    }
    // The addressee decides only while they are still in the Workspace.
    await this.requireWorkspaceMember(offer.workspace_id, viewerId);
    if (offer.status === 'connecting' && offer.accepted_by !== viewerId)
      throw new Error('connector offer conflict: sign-in is already in progress');
    // The helper is the offering agent's machine; it must still be here to install.
    const helper = await this.database.query(
      `SELECT 1 FROM agents a
       JOIN memberships m ON m.identity_id=a.agent_id AND m.workspace_id=$2
         AND m.room_id IS NULL AND m.removed_at IS NULL
       WHERE a.agent_id=$1`,
      [offer.agent_id, offer.workspace_id],
    );
    if (!helper.rowCount)
      throw new Error('connector offer conflict: the offering agent has left this Workspace');
    const acceptor = await this.requireIdentity(viewerId);
    const paired = await this.database.transaction(async (database) => {
      const updated = await database.query<{ accepted_at: Date }>(
        `UPDATE connector_offers SET status='connecting',accepted_by=$2,
             accepted_at=COALESCE(accepted_at,now())
         WHERE id::text=$1 AND status='pending' RETURNING accepted_at`,
        [input.offerId, viewerId],
      );
      const acceptedAt = updated.rows[0]?.accepted_at ?? offer.accepted_at;
      if (!acceptedAt || (offer.status !== 'pending' && offer.status !== 'connecting'))
        throw new Error('connector offer conflict: already accepted');
      const pairing = await this.armConnectorPairing(database, {
        workspaceId: offer.workspace_id,
        ownerIdentityId: viewerId,
        connectorType,
        helperAgentId: offer.agent_id,
        machineId: offer.machine_id,
      });
      await database.query(`UPDATE connector_offers SET connector_id=$2::uuid WHERE id::text=$1`, [
        input.offerId,
        pairing.connectorId,
      ]);
      await this.markConnectorOfferConnecting(database, {
        roomId: offer.room_id,
        offerId: input.offerId,
        acceptedBy: acceptor,
        acceptedAt,
        connectorId: pairing.connectorId,
      });
      return pairing;
    });
    return {
      offerId: input.offerId,
      status: 'connecting',
      roomId: offer.room_id,
      connectorId: paired.connectorId,
    };
  }
  /**
   * Mark the card as an in-progress ceremony. It still names who acted and
   * carries the Workbench row id, but it cannot claim the tool was added until
   * the helper's connected report settles it.
   */
  private async markConnectorOfferConnecting(
    database: SqlDatabase,
    input: {
      roomId: string;
      offerId: string;
      acceptedBy: RoomViewIdentity;
      acceptedAt: Date;
      connectorId: string;
    },
  ) {
    const card = (
      await database.query<{ id: string; card: ConnectorOfferCardView }>(
        `SELECT id,card FROM messages
         WHERE room_id=$1 AND card_type='connector-offer' AND card->>'offerId'=$2
         ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [input.roomId, input.offerId],
      )
    ).rows[0];
    if (!card || !['pending', 'connecting'].includes(card.card.status)) return;
    const connecting: ConnectorOfferCardView = {
      ...card.card,
      status: 'connecting',
      acceptedBy: input.acceptedBy,
      acceptedAt: unix(input.acceptedAt),
      connectorId: input.connectorId,
    };
    await database.query(`UPDATE messages SET card=$2::jsonb WHERE id=$1`, [
      card.id,
      JSON.stringify(connecting),
    ]);
  }
  /**
   * The agent "yolo" switch. Authorization is decided here, never on the phone:
   * the viewer must be the agent's owner (the identity that connected it).
   * Public Workspaces reject enabling yolo while preserving the stored value
   * for a later return to invite-only. A flip posts one system line
   * to every live Room the agent is in so the change is visible where the
   * agent works; the line carries no mention and never pushes.
   */
  private async updateAgentYolo(input: Input<'updateAgentYolo'>, viewerId: string) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled is required');
    const agent = (
      await this.database.query<{
        owner_id: string;
        agent_name: string;
        viewer_name: string;
        workspace_visibility: 'public' | 'invite-only';
      }>(
        `SELECT a.owner_id,agent.name agent_name,viewer.name viewer_name,
                workspace.visibility workspace_visibility
         FROM agents a
         JOIN identities agent ON agent.id=a.agent_id
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.workspace_id=$2 AND m.room_id IS NULL AND m.removed_at IS NULL
         JOIN identities viewer ON viewer.id=$3
         JOIN workspaces workspace ON workspace.id=$2
         WHERE a.agent_id=$1`,
        [input.agentId, input.workspaceId, viewerId],
      )
    ).rows[0];
    if (!agent) throw new Error('agent not found in workspace');
    await this.requireWorkspaceMember(input.workspaceId, viewerId);
    if (agent.owner_id !== viewerId) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
    if (input.enabled && agent.workspace_visibility === 'public')
      throw new Error('yolo cannot be enabled in a public workspace');
    await this.database.transaction(async (database) => {
      const changed = await database.query(
        `UPDATE agents SET yolo_mode=$2,yolo_set_by=$3,yolo_set_at=now(),updated_at=now()
         WHERE agent_id=$1 AND yolo_mode<>$2`,
        [input.agentId, input.enabled, viewerId],
      );
      if (!changed.rowCount) return;
      const rooms = await database.query<{ room_id: string }>(
        `SELECT m.room_id FROM memberships m
         JOIN rooms r ON r.id=m.room_id
         WHERE m.identity_id=$1 AND m.room_id IS NOT NULL AND m.removed_at IS NULL
           AND r.workspace_id=$2 AND r.archived_at IS NULL`,
        [input.agentId, input.workspaceId],
      );
      for (const room of rooms.rows)
        await systemLine(database, {
          roomId: room.room_id,
          subject: { kind: 'person', id: viewerId, name: agent.viewer_name },
          verb: input.enabled ? 'turned yolo on for' : 'turned yolo off for',
          object: { text: agent.agent_name, id: input.agentId },
          consequence: input.enabled
            ? 'grant requests are now approved automatically'
            : 'grant requests now ask before running',
          cardType: 'agent-yolo',
          card: { agentId: input.agentId, enabled: input.enabled },
        });
    });
  }
  /**
   * Who may address this agent. Authorization belongs only to the agent's owner
   * (the identity that connected it). The row is the ONLY
   * authority — a running helper reads it through `getRoomAuthority` on its next
   * poll, so the change takes effect without a reconnect or a restart.
   *
   * A change posts one system line to every active person's read-only @system
   * DM. It is Workspace configuration, not activity in every Room the agent is
   * in, and no agent should be woken by the notice.
   */
  private async updateAgentAccessPolicy(input: Input<'updateAgentAccessPolicy'>, viewerId: string) {
    if (!isAgentAccessPolicy(input.policy)) throw new Error('policy is invalid');
    const allow = input.policy === 'allowlist' ? (input.allow ?? []) : [];
    if (input.policy === 'allowlist') {
      if (!allow.length || allow.length > MAX_ACCESS_ALLOWLIST_ENTRIES)
        throw new Error('allowlist is invalid');
      if (allow.some((entry) => typeof entry !== 'string' || !/^[0-9a-f]{64}$/.test(entry)))
        throw new Error('allowlist is invalid');
    }
    const agent = (
      await this.database.query<{
        owner_id: string;
        agent_name: string;
        viewer_handle: string | null;
        owner_handle: string | null;
      }>(
        `SELECT a.owner_id,agent.name agent_name,viewer.handle viewer_handle,owner.handle owner_handle
         FROM agents a
         JOIN identities agent ON agent.id=a.agent_id
         JOIN identities owner ON owner.id=a.owner_id
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.workspace_id=$2 AND m.room_id IS NULL AND m.removed_at IS NULL
         JOIN identities viewer ON viewer.id=$3
         WHERE a.agent_id=$1`,
        [input.agentId, input.workspaceId, viewerId],
      )
    ).rows[0];
    if (!agent) throw new Error('agent not found in workspace');
    await this.requireWorkspaceMember(input.workspaceId, viewerId);
    if (agent.owner_id !== viewerId) throw new Error(ACCESS_POLICY_AUTHORITY_MESSAGE);
    await this.database.transaction(async (database) => {
      const changed = await database.query(
        `UPDATE agents SET access_policy=$2::jsonb,updated_at=now()
         WHERE agent_id=$1 AND access_policy<>$2::jsonb`,
        [input.agentId, JSON.stringify(agentAccessPolicyRecord(input.policy, allow))],
      );
      if (!changed.rowCount) return;
      await workspaceSystemLine(database, {
        workspaceId: input.workspaceId,
        subject: {
          kind: 'person',
          id: viewerId,
          // Named by @handle like every other person in a system line; a
          // person with no handle is left unnamed rather than described.
          name: personMention(agent.viewer_handle) ?? 'Someone',
        },
        verb: 'changed who may address',
        object: { text: agent.agent_name, id: input.agentId },
        consequence:
          input.policy === 'everyone'
            ? 'anyone may ask now'
            : input.policy === 'creator'
              ? `only ${personMention(agent.owner_handle) ?? 'the owner'} may ask now`
              : 'only an allowed member may ask now',
        cardType: 'agent-access',
      });
    });
  }
  /**
   * Roll back an agent registration whose connect helper never came up. Only
   * an agent that has NEVER reported presence is unrealizable: anything else
   * is a real daemon and must be removed by a human through removeAgent.
   */
  async rollbackUnrealizedAgent(agentId: string) {
    const claimed = await this.database.query(
      `SELECT 1 FROM agent_pairing_codes WHERE claimed_by=$1`,
      [agentId],
    );
    if (!claimed.rowCount) throw new Error('pairing not found');
    const ran = await this.database.query(
      `SELECT 1 FROM live_outputs WHERE agent_id=$1 AND kind='presence' LIMIT 1`,
      [agentId],
    );
    if (ran.rowCount) throw new Error('agent already ran; use removeAgent instead');
    await this.database.query(
      `UPDATE memberships SET removed_at=now()
       WHERE identity_id=$1 AND removed_at IS NULL`,
      [agentId],
    );
    await this.database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [
      agentId,
    ]);
  }

  /**
   * Removing an agent RETIRES it. Presence and authority end, its
   * configuration is cleared so the same key can never inherit it, and
   * everything that would still fire on its behalf stops — but the record of
   * what it did stays: `agent_turns` and every message it authored are left
   * exactly where they are, because the Room's account of the work outlives
   * the worker.
   *
   * The `agents` row is cleared in place rather than deleted. Grant history
   * and the agent detail read both join it for `owner_id`, so the row is what
   * keeps "who connected this agent" answerable after the fact; only the
   * mutable configuration — soul, model, effort, catalog, commands, schedule
   * ids, access policy, yolo and its setter — is reset to a freshly-paired
   * shape.
   *
   * A corner this agent owns is archived, exactly as a merged corner is:
   * every corner write admits only its owner agent, so an open corner behind
   * a retired agent is a Room nobody can advance and a pin the captain cannot
   * clear. It settles as `done`/`abandoned` with the reason, keeping its
   * transcript and its PR link readable.
   */
  private async removeAgent(input: Input<'removeAgent'>, viewerId: string) {
    await this.requireWorkspaceAgentRemover(input.workspaceId, input.agentId, viewerId);
    const remover = await this.requireIdentity(viewerId);
    const removed = await this.requireIdentity(input.agentId);
    await this.database.transaction(async (database) => {
      await database.query(
        `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
        [input.workspaceId, input.agentId],
      );
      await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [
        input.agentId,
      ]);
      // No surface may draw it as a member again, whatever it reads from.
      await database.query(
        `UPDATE identities SET hidden_from_roster=true,updated_at=now()
         WHERE id=$1 AND kind='agent'`,
        [input.agentId],
      );
      await database.query(
        `UPDATE agents SET soul=NULL,selected_model=NULL,selected_effort=NULL,
           model_catalog='[]'::jsonb,model_unavailable=NULL,commands='[]'::jsonb,
           schedule_ids='[]'::jsonb,
           yolo_mode=false,yolo_set_by=NULL,yolo_set_at=NULL,
           access_policy='{"type":"everyone"}'::jsonb,updated_at=now()
         WHERE agent_id=$1`,
        [input.agentId],
      );
      // Nothing may fire for an agent that is gone; occurrences cascade.
      await database.query(`DELETE FROM agent_schedules WHERE agent_id=$1 AND workspace_id=$2`, [
        input.agentId,
        input.workspaceId,
      ]);
      const revoked = await database.query<{ id: string; room_id: string; decided_at: Date }>(
        `UPDATE agent_grants SET status='revoked',decided_by=$3,decided_at=now()
         WHERE agent_id=$1 AND workspace_id=$2 AND status IN ('pending','approved','once')
         RETURNING id,room_id,decided_at`,
        [input.agentId, input.workspaceId, viewerId],
      );
      for (const grant of revoked.rows)
        await this.settleGrantCard(database, {
          roomId: grant.room_id,
          grantId: grant.id,
          status: 'revoked',
          decidedBy: remover,
          decidedAt: grant.decided_at,
        });
      // Removal retires the helper; it never closes the corners. A corner is
      // carried by its MEMBERS, and the branch/PR is a shared artifact other
      // people may still land. The removed agent's `owner_agent_id` stays as
      // the historical "opened by"; the merge webhook and a human close still
      // reach the corner, and a later helper can be addressed in it.
      await workspaceSystemLine(database, {
        workspaceId: input.workspaceId,
        subject: identitySubject({ id: remover.pubkey, kind: remover.kind, name: remover.name }),
        verb: 'removed',
        object: { text: removed.name, id: removed.pubkey },
        cardType: 'member-removed',
        card: { identityId: input.agentId },
      });
    });
  }
  /**
   * Deletes the signed-in person's account and personal data — a real
   * `DELETE FROM identities`, not a flag — in one transaction:
   *
   *   - every agent the account owns is removed outright (its identity row
   *     goes too); its daemon tokens, schedules and grants die with it, and
   *     the corners it owned lose their owner and archive as
   *     `done`/`abandoned` (account deletion is a full erasure, so those
   *     corners cannot wait for a helper);
   *   - Workspace/Room ownership the account held alone passes to the
   *     longest-serving remaining human (admin first), so shared surfaces
   *     stay manageable;
   *   - messages the account or its agents authored in Rooms, corners and
   *     DMs that others still read remain as the conversation record (the
   *     privacy page's "Room content may remain available" rule) but are
   *     re-attributed to the hidden DELETED_ACCOUNT_IDENTITY_ID author and
   *     stripped of their mentions of the deleted ids;
   *   - DM Rooms whose only other participants were the account's own agents
   *     are deleted outright — nobody else relies on them;
   *   - sessions, access/refresh/daemon tokens, push devices, media bytes,
   *     GitHub tokens/links/installations, invites, pairing codes, grants,
   *     read marks and succession rows all go with the identity row's
   *     cascades.
   *
   * Idempotent: once the identity row is gone the operation resolves without
   * effect, so a retried or doubled call never errors. A fresh GitHub sign-in
   * with the same subject afterwards creates a NEW account.
   */
  private async deleteAccount(viewerId: string) {
    if (viewerId === SYSTEM_IDENTITY_ID) throw new Error('only a person may delete their account');
    // Idempotency floor: an already-deleted account reads as an empty graph.
    const held = await this.database.query(`SELECT 1 FROM identities WHERE id=$1`, [viewerId]);
    if (!held.rowCount) return;
    const account = await this.requireIdentity(viewerId);
    if (account.kind !== 'human') throw new Error('only a person may delete their account');
    await this.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM identities WHERE id=$1 FOR UPDATE`, [viewerId]);
      if (!(await database.query(`SELECT 1 FROM identities WHERE id=$1`, [viewerId])).rowCount)
        return;
      const owned = await database.query<{ agent_id: string }>(
        `SELECT agent_id FROM agents WHERE owner_id=$1`,
        [viewerId],
      );
      // Everything erased by this deletion: the person and each agent it owned.
      const gone = [viewerId, ...owned.rows.map((row) => row.agent_id)];

      // The agents are removed, not re-owned: tokens, schedules and grants die
      // with them, and their corners archive as removeAgent archives them.
      await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=ANY($1)`, [
        gone,
      ]);
      await database.query(
        `DELETE FROM agent_grants WHERE agent_id=ANY($1) OR requested_by=ANY($1)`,
        [gone],
      );
      await database.query(`UPDATE agent_grants SET decided_by=NULL WHERE decided_by=ANY($1)`, [
        gone,
      ]);
      await database.query(
        `UPDATE rooms SET archived_at=now(),updated_at=now()
         WHERE parent_id IS NOT NULL AND archived_at IS NULL
           AND id IN (SELECT corner_id FROM corner_facts WHERE owner_agent_id=ANY($1))`,
        [gone],
      );
      await database.query(
        `UPDATE corner_facts SET close_requested=true,owner_agent_id=NULL,
           lifecycle=lifecycle||$2::jsonb,updated_at=now()
         WHERE owner_agent_id=ANY($1)`,
        [
          gone,
          JSON.stringify({
            lifecycle: 'done',
            outcome: 'abandoned',
            reason: `${account.name} deleted their account`,
          }),
        ],
      );
      await database.query(
        `DELETE FROM agent_schedules WHERE agent_id=ANY($1) OR creator_id=ANY($1)`,
        [gone],
      );

      // Ownership the account held alone passes to the longest-serving
      // remaining human (admin first), so the shared surfaces stay manageable.
      await database.query(
        `WITH lone AS (
           SELECT m.workspace_id FROM memberships m
           WHERE m.room_id IS NULL AND m.role='owner' AND m.removed_at IS NULL
             AND m.identity_id=ANY($1)
             AND NOT EXISTS (SELECT 1 FROM memberships o
                             WHERE o.workspace_id=m.workspace_id AND o.room_id IS NULL
                               AND o.role='owner' AND o.removed_at IS NULL
                               AND o.identity_id <> ALL($1))
         ), heir AS (
           SELECT DISTINCT ON (l.workspace_id) l.workspace_id,h.identity_id
           FROM lone l
           JOIN memberships h ON h.workspace_id=l.workspace_id AND h.room_id IS NULL
             AND h.role IN ('admin','member') AND h.removed_at IS NULL
             AND h.identity_id <> ALL($1)
           JOIN identities hi ON hi.id=h.identity_id AND hi.kind='human'
           ORDER BY l.workspace_id,h.role,h.joined_at,h.identity_id
         )
         UPDATE memberships m SET role='owner' FROM heir
         WHERE m.workspace_id=heir.workspace_id AND m.identity_id=heir.identity_id`,
        [gone],
      );
      await database.query(
        `WITH lone AS (
           SELECT m.room_id FROM memberships m JOIN rooms r ON r.id=m.room_id
           WHERE m.room_id IS NOT NULL AND r.parent_id IS NULL AND r.archived_at IS NULL
             AND m.role='owner' AND m.removed_at IS NULL AND m.identity_id=ANY($1)
             AND NOT EXISTS (SELECT 1 FROM memberships o
                             WHERE o.room_id=m.room_id AND o.role='owner'
                               AND o.removed_at IS NULL AND o.identity_id <> ALL($1))
         ), heir AS (
           SELECT DISTINCT ON (l.room_id) l.room_id,h.identity_id
           FROM lone l
           JOIN memberships h ON h.room_id=l.room_id AND h.role IN ('admin','member')
             AND h.removed_at IS NULL AND h.identity_id <> ALL($1)
           JOIN identities hi ON hi.id=h.identity_id AND hi.kind='human'
           ORDER BY l.room_id,h.role,h.joined_at,h.identity_id
         )
         UPDATE memberships m SET role='owner' FROM heir
         WHERE m.room_id=heir.room_id AND m.identity_id=heir.identity_id`,
        [gone],
      );

      // Authored content survives as the shared record, anonymised to the one
      // hidden tombstone author. Nothing strips the tags those people were
      // named by: a tag is read against current membership, and a deleted
      // account is no longer a member, so its old @handle already names nobody.
      await database.query(
        `INSERT INTO identities(id,kind,name,hidden_from_roster,github_subject)
         VALUES ($1,'human',$2,true,NULL) ON CONFLICT (id) DO NOTHING`,
        [DELETED_ACCOUNT_IDENTITY_ID, DELETED_ACCOUNT_NAME],
      );
      await database.query(`UPDATE messages SET author_id=$2 WHERE author_id=ANY($1)`, [
        gone,
        DELETED_ACCOUNT_IDENTITY_ID,
      ]);

      // DM Rooms nobody else relies on (person↔own-agent) go with the account;
      // the rest lose the deleted participant from their participant list.
      await database.query(
        `UPDATE rooms SET direct_participants=(
           SELECT coalesce(jsonb_agg(p),'[]'::jsonb)
           FROM jsonb_array_elements(direct_participants) p
           WHERE p#>>'{}' <> ALL($1))
         WHERE direct_participants IS NOT NULL`,
        [gone],
      );
      await database.query(
        `DELETE FROM rooms WHERE direct_participants IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM memberships m JOIN identities i ON i.id=m.identity_id
           WHERE m.room_id=rooms.id AND m.removed_at IS NULL
             AND i.kind='human' AND i.id <> ALL($1))`,
        [gone],
      );

      // Receipts, output streams and authority rows that point at the gone ids.
      await database.query(`DELETE FROM live_outputs WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM agent_turns WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM work_schedules WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM schedule_receipts WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM agent_mandates WHERE agent_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM permission_authority WHERE principal_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM mission_authority WHERE principal_id=ANY($1)`, [gone]);
      await database.query(`DELETE FROM corner_merge_approvals WHERE approved_by=ANY($1)`, [gone]);
      await database.query(`DELETE FROM invites WHERE created_by=ANY($1)`, [gone]);
      await database.query(
        `DELETE FROM agent_pairing_codes WHERE created_by=ANY($1) OR claimed_by=ANY($1)`,
        [gone],
      );
      await database.query(
        `DELETE FROM identity_successions
         WHERE old_identity_id=ANY($1) OR new_identity_id=ANY($1)`,
        [gone],
      );

      // Object bytes are personal data: the rows go, and a tombstone keeps the
      // readers' story the one media-ttl.ts already tells (expired, not lost).
      await database.query(
        `WITH swept AS (DELETE FROM objects WHERE owner_id=ANY($1) RETURNING id,kind)
         INSERT INTO object_expirations(id,retention_hours)
         SELECT id,CASE kind WHEN 'artifact' THEN $2::integer ELSE $3::integer END FROM swept
         ON CONFLICT(id) DO NOTHING`,
        [gone, ARTIFACT_TTL_HOURS, mediaTtlHours()],
      );

      // Rooms and GitHub connections the account created: the artifacts stay,
      // the attribution goes.
      await database.query(`UPDATE rooms SET created_by=NULL WHERE created_by=ANY($1)`, [gone]);
      await database.query(`DELETE FROM github_installations WHERE owner_id=ANY($1)`, [gone]);
      await database.query(
        `DELETE FROM github_user_tokens WHERE subject IN (
           SELECT github_subject FROM identities WHERE id=$1 AND github_subject IS NOT NULL)`,
        [viewerId],
      );

      // The account itself. Sessions, access/refresh/daemon tokens, push
      // devices, memberships, external links, read marks and the agent rows
      // all follow through ON DELETE CASCADE. The agents go first so their
      // rows' owner_id link dies before the owner's row does.
      await database.query(`DELETE FROM identities WHERE id=ANY($1) AND kind='agent'`, [gone]);
      await database.query(`DELETE FROM identities WHERE id=$1`, [viewerId]);
    });
  }
  private async updateProfile(input: Input<'updatePersonProfile'>, viewerId: string) {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 60))
      throw new Error('invalid person name');
    if (
      input.handle !== undefined &&
      !/^[a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?$/.test(input.handle)
    )
      throw new Error('invalid person handle');
    return this.database.transaction(async (database) => {
      if (input.handle !== undefined) {
        const workspaceIds = await lockIdentityHandleWorkspaces(database, viewerId);
        await reassignCollidingAgentHandles(database, viewerId, input.handle, workspaceIds);
      }
      const updated = await database.query<IdentityRow>(
        `UPDATE identities
         SET name=CASE WHEN $2::text IS NULL THEN name ELSE $2 END,
             handle=CASE WHEN $3::text IS NULL THEN handle ELSE $3 END,
             avatar=CASE WHEN $4::text IS NULL THEN avatar ELSE NULLIF($4,'') END,
             updated_at=now()
         WHERE id=$1
         RETURNING id,kind,name,handle,avatar`,
        [viewerId, input.name ?? null, input.handle ?? null, input.avatar ?? null],
      );
      const profile = updated.rows[0];
      if (!profile) throw new Error('identity not found');
      return {
        personId: profile.id,
        name: profile.name,
        ...(profile.handle ? { handle: profile.handle } : {}),
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
      };
    });
  }
  /** The face ceremony: one of `FACE_IDS` for the viewer's own identity, or null to clear. */
  private async updateFace(input: Input<'updateIdentityFace'>, viewerId: string) {
    if (input.faceId !== null && !isFaceId(input.faceId)) throw new Error('invalid face id');
    const updated = await this.database.query(
      `UPDATE identities SET face_id=$2,updated_at=now() WHERE id=$1`,
      [viewerId, input.faceId],
    );
    if (!updated.rowCount) throw new Error('identity not found');
  }
  private async updatePushLevel(input: Input<'updateIdentityPushLevel'>, viewerId: string) {
    if (!isPushLevel(input.pushLevel)) throw new Error('invalid push level');
    const updated = await this.database.query(
      `UPDATE identities SET push_level=$2,updated_at=now() WHERE id=$1 AND kind='human'`,
      [viewerId, input.pushLevel],
    );
    if (!updated.rowCount) throw new Error('identity not found');
    return this.managedIdentity(viewerId);
  }
  private async setRepository(input: Input<'setRoomRepository'>, viewerId: string) {
    await this.requireRoomWorkspaceManager(input.roomId, viewerId);
    if (input.githubInstallationId !== undefined) {
      const repositoryId = input.key.match(/^github:(\d+)$/)?.[1];
      const fullName = input.remote.match(/^git:\/\/github\.com\/([^/\s]+\/[^/\s]+)$/i)?.[1];
      if (!repositoryId || !fullName || input.name.toLowerCase() !== fullName.toLowerCase())
        throw new Error('GitHub repository binding is invalid');
      const access = await this.database.query(
        `SELECT 1 FROM github_repositories r JOIN github_installations i USING(installation_id) WHERE r.repository_id=$1 AND r.installation_id=$2 AND lower(r.full_name)=lower($3) AND r.active AND i.owner_id=$4 AND i.status='active'`,
        [repositoryId, input.githubInstallationId, fullName, viewerId],
      );
      if (!access.rowCount) throw new Error('GitHub repository access denied');
    }
    await this.database.query(
      `UPDATE rooms SET repository_key=$2,repository_name=$3,repository_remote=$4,repository_target_branch=$5,github_installation_id=$6,repository_updated_at=now(),repository_resolution='repository',updated_at=now() WHERE id=$1`,
      [
        input.roomId,
        input.key,
        input.name,
        input.remote,
        input.targetBranch,
        input.githubInstallationId ?? null,
      ],
    );
    return this.roomRepository(input.roomId);
  }
  /**
   * Sever the Room→repository association: the Room becomes chat-only.
   *
   * This clears only the binding columns on the Room row. The repository
   * itself, the Room, its messages, and its history are untouched, and any
   * corner already opened from this Room keeps its own copy of the binding
   * (corners carry their repository columns independently of the parent).
   * Deliberately idempotent: unassigning an already chat-only Room is a
   * quiet no-op, so a retried call succeeds.
   */
  private async removeRepositoryBinding(input: Input<'removeRoomRepository'>, viewerId: string) {
    await this.requireRoomWorkspaceManager(input.roomId, viewerId);
    await this.database.query(
      `UPDATE rooms
       SET repository_key=NULL,repository_name=NULL,repository_remote=NULL,
           repository_target_branch='main',github_installation_id=NULL,
           repository_resolution='none',github_events_enabled=true,
           repository_updated_at=now(),updated_at=now()
       WHERE id=$1`,
      [input.roomId],
    );
  }
  private async roomRepository(roomId: string) {
    const row = (await this.database.query<RoomRow>(`SELECT * FROM rooms WHERE id=$1`, [roomId]))
      .rows[0];
    if (!row?.repository_key || !row.repository_remote)
      throw new Error('room repository not configured');
    return {
      channelId: roomId,
      binding: {
        key: row.repository_key,
        name: row.repository_name ?? row.repository_key,
        remote: row.repository_remote,
        localOnly: false as const,
        ...(row.github_installation_id
          ? { githubInstallationId: Number(row.github_installation_id) }
          : {}),
      },
      targetBranch: row.repository_target_branch,
      updatedAt: unix(row.repository_updated_at ?? row.updated_at),
      githubEventsEnabled: row.github_events_enabled,
      source: 'config' as const,
    };
  }
  private async setTargetBranch(input: Input<'setRoomTargetBranch'>, viewerId: string) {
    await this.requireRoomWorkspaceManager(input.roomId, viewerId);
    const updated = await this.database.query(
      `UPDATE rooms SET repository_target_branch=$2,repository_updated_at=now(),updated_at=now() WHERE id=$1 AND repository_key IS NOT NULL AND repository_remote IS NOT NULL`,
      [input.roomId, input.targetBranch],
    );
    if (!updated.rowCount) throw new Error('room repository not configured');
    return this.roomRepository(input.roomId);
  }
  private async setGitHubEvents(input: Input<'setRoomGitHubEvents'>, viewerId: string) {
    await this.requireRoomWorkspaceManager(input.roomId, viewerId);
    const updated = await this.database.query(
      `UPDATE rooms SET github_events_enabled=$2,repository_updated_at=now(),updated_at=now() WHERE id=$1 AND repository_key IS NOT NULL AND repository_remote IS NOT NULL`,
      [input.roomId, input.enabled],
    );
    if (!updated.rowCount) throw new Error('room repository not configured');
    return this.roomRepository(input.roomId);
  }
  private async managedIdentity(viewerId: string) {
    const id = await this.requireIdentity(viewerId);
    const pushLevel = (
      await this.database.query<{ push_level: import('@beeline/api-contract/phone').PushLevel }>(
        `SELECT push_level FROM identities WHERE id=$1`,
        [viewerId],
      )
    ).rows[0]?.push_level;
    return {
      personId: id.pubkey,
      name: id.name,
      ...(id.handle ? { handle: id.handle } : {}),
      ...(id.avatar ? { avatar: id.avatar } : {}),
      ...(id.face ? { face: id.face } : {}),
      pushLevel: pushLevel ?? 'mine',
    };
  }
  private async claimManagedHandle(viewerId: string, handle: string) {
    await this.database.transaction(async (database) => {
      const workspaceIds = await lockIdentityHandleWorkspaces(database, viewerId);
      await reassignCollidingAgentHandles(database, viewerId, handle, workspaceIds);
      const claimed = await database.query(
        `UPDATE identities AS identity SET handle=$2,updated_at=now()
         WHERE identity.id=$1 AND NOT EXISTS(
           SELECT 1 FROM identities AS other
           WHERE other.id<>$1 AND other.kind='human' AND lower(other.handle)=lower($2)
         )`,
        [viewerId, handle],
      );
      if (claimed.rowCount === 0) throw new Error('managed handle is already claimed');
    });
  }
  private async adoptGitHubHandle(viewerId: string) {
    const link = (
      await this.database.query<{ provider_login: string | null }>(
        `SELECT provider_login FROM identity_external_links
         WHERE provider='github' AND identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    if (!link?.provider_login) throw new Error('GitHub handle is not available');
    await this.claimManagedHandle(viewerId, link.provider_login.toLowerCase());
    return this.managedIdentity(viewerId);
  }
  private async identityRecovery(viewerId: string) {
    const rows = await this.database.query<{ id: string; handle: string | null }>(
      `WITH RECURSIVE predecessors(id) AS (SELECT old_identity_id FROM identity_successions WHERE new_identity_id=$1 UNION ALL SELECT s.old_identity_id FROM identity_successions s JOIN predecessors p ON s.new_identity_id=p.id) SELECT i.id,i.handle FROM predecessors p JOIN identities i ON i.id=p.id`,
      [viewerId],
    );
    return {
      candidates: rows.rows.map((row) => ({
        personId: row.id,
        ...(row.handle ? { handle: row.handle } : {}),
      })),
    };
  }
  private async listRepositories(viewerId: string) {
    const installations = await this.database.query<{
      installation_id: string;
      account_id: string | null;
      account_login: string;
      account_type: 'User' | 'Organization';
      account_avatar_url: string | null;
      repository_selection: 'all' | 'selected';
      status: 'active' | 'revoked' | 'suspended';
      repository_count: string;
    }>(
      `SELECT i.*,count(r.repository_id) FILTER (WHERE r.active)::text repository_count FROM github_installations i LEFT JOIN github_repositories r USING(installation_id) WHERE i.owner_id=$1 GROUP BY i.installation_id ORDER BY lower(i.account_login),i.installation_id`,
      [viewerId],
    );
    const rows = await this.database.query<{
      repository_id: string;
      full_name: string;
      installation_id: string;
      default_branch: string;
    }>(
      `SELECT r.* FROM github_repositories r JOIN github_installations i USING(installation_id) WHERE i.owner_id=$1 AND i.status='active' AND r.active`,
      [viewerId],
    );
    return {
      installed: installations.rows.some((row) => row.status === 'active'),
      installations: installations.rows.map((row) => ({
        installationId: Number(row.installation_id),
        // Pre-cutover imports did not retain GitHub's numeric account id. The
        // login is still a stable, non-empty display grouping until the next
        // refresh backfills the authoritative id from GitHub.
        accountId: row.account_id ?? row.account_login,
        accountLogin: row.account_login,
        accountType: row.account_type,
        ...(row.account_avatar_url ? { accountAvatarUrl: row.account_avatar_url } : {}),
        repositorySelection: row.repository_selection,
        status: row.status,
        repositoryCount: Number(row.repository_count),
        manageUrl:
          row.account_type === 'Organization'
            ? `https://github.com/organizations/${encodeURIComponent(row.account_login)}/settings/installations/${row.installation_id}`
            : `https://github.com/settings/installations/${row.installation_id}`,
      })),
      repositories: rows.rows.map((row) => ({
        id: Number(row.repository_id),
        fullName: row.full_name,
        installationId: Number(row.installation_id),
        defaultBranch: row.default_branch,
      })),
    };
  }
  private async repositoryAccess(fullName: string, viewerId: string) {
    const row = await this.database.query(
      `SELECT 1 FROM github_repositories r JOIN github_installations i USING(installation_id) WHERE lower(r.full_name)=lower($1) AND i.owner_id=$2 AND r.active`,
      [fullName, viewerId],
    );
    return {
      accessible: row.rowCount > 0,
      ...(!row.rowCount ? { reason: 'repository_not_installed' } : {}),
    };
  }
  private async registerPush(input: Input<'registerPushDevice'>, viewerId: string) {
    await this.database.transaction(async (database) => {
      await database.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(token) DO UPDATE SET identity_id=EXCLUDED.identity_id,platform=EXCLUDED.platform,environment=EXCLUDED.environment,registered_at=CASE WHEN push_devices.identity_id IS DISTINCT FROM EXCLUDED.identity_id THEN now() ELSE push_devices.registered_at END,updated_at=now()`,
        [input.token, viewerId, input.platform, input.environment],
      );
      await queueLatestReleasePush(database, viewerId, input.token);
    });
    return { accepted: true };
  }
  private async reportUpdate(input: Input<'reportRunningUpdate'>, viewerId: string) {
    await this.database.query(
      `INSERT INTO device_update_receipts(identity_id,device_id,receipt) VALUES($1,$2,$3::jsonb) ON CONFLICT(identity_id,device_id) DO UPDATE SET receipt=EXCLUDED.receipt,reported_at=now()`,
      [viewerId, input.deviceId, JSON.stringify(input)],
    );
  }
  private requireGitHub() {
    if (!this.github) throw new Error('GitHub service is not configured');
    return this.github;
  }
  private async requireIdentity(id: string, database: SqlDatabase = this.database) {
    const row = (
      await database.query<IdentityRow>(
        `SELECT id,kind,name,handle,avatar,face_id FROM identities WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('identity not found');
    return identity(row, this.publicOrigin);
  }
  private async requireWorkspaceAgent(workspaceId: string, agentId: string, viewerId: string) {
    const result = await this.database.query<{ owner_id: string }>(
      `SELECT a.owner_id
       FROM agents a
       JOIN memberships m ON m.identity_id=a.agent_id
       WHERE a.agent_id=$1 AND m.workspace_id=$2
         AND m.room_id IS NULL AND m.removed_at IS NULL`,
      [agentId, workspaceId],
    );
    if (!result.rows[0]) throw new Error('agent not found in workspace');
    await this.requireWorkspaceMember(workspaceId, viewerId);
    if (result.rows[0].owner_id !== viewerId) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
  }
  private async requireWorkspaceAgentRemover(
    workspaceId: string,
    agentId: string,
    viewerId: string,
  ) {
    const result = await this.database.query<{ owner_id: string; viewer_role: string | null }>(
      `SELECT a.owner_id,viewer_membership.role viewer_role
       FROM agents a
       JOIN memberships agent_membership ON agent_membership.identity_id=a.agent_id
       LEFT JOIN memberships viewer_membership ON viewer_membership.workspace_id=agent_membership.workspace_id
         AND viewer_membership.room_id IS NULL AND viewer_membership.identity_id=$3
         AND viewer_membership.removed_at IS NULL
       WHERE a.agent_id=$1 AND agent_membership.workspace_id=$2
         AND agent_membership.room_id IS NULL AND agent_membership.removed_at IS NULL`,
      [agentId, workspaceId, viewerId],
    );
    const agent = result.rows[0];
    if (!agent) throw new Error('agent not found in workspace');
    if (!agent.viewer_role) throw new Error('workspace membership required');
    if (
      agent.owner_id !== viewerId &&
      agent.viewer_role !== 'owner' &&
      agent.viewer_role !== 'admin'
    )
      throw new Error('agent removal access denied');
  }
  private async requireWorkspaceMember(workspaceId: string, identityId: string) {
    const row = await this.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
       AND identity_id=$2 AND removed_at IS NULL`,
      [workspaceId, identityId],
    );
    if (!row.rowCount) throw new Error('workspace membership required');
  }
  private async hasRoomAccess(roomId: string, identityId: string) {
    return (
      (
        await this.database.query(
          `SELECT 1 FROM memberships room_member
           JOIN rooms room ON room.id=room_member.room_id
           WHERE room_member.room_id=$1 AND room_member.identity_id=$2
             AND room_member.removed_at IS NULL
             AND ($2=$3 OR EXISTS(
               SELECT 1 FROM memberships workspace_member
               WHERE workspace_member.workspace_id=room.workspace_id
                 AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
                 AND workspace_member.removed_at IS NULL
             ))`,
          [roomId, identityId, SYSTEM_IDENTITY_ID],
        )
      ).rowCount > 0
    );
  }
  /**
   * An `@system` notification DM (release or Workspace lifecycle) is
   * read-only: only `@system` may post into a direct-message Room it is a
   * participant of. A person who IS a member of that Room (they must be, to
   * read it) still cannot send or reply, so this is distinct from
   * `hasRoomAccess`.
   */
  // --- Workbench: connector provisioning and connection sovereignty ------------

  private async assertWorkbenchViewer(_workspaceId: string, viewerId: string): Promise<void> {
    // The Workbench is human-scoped: a paired tool and its keys belong to the
    // person, not a Workspace, and the screen sends no workspace id. Authorize
    // on the authenticated viewer being a member of ANY Workspace, never on a
    // client-supplied id (an empty one used to be cast to uuid and throw).
    await this.viewerWorkbenchWorkspace(viewerId);
  }

  /**
   * A stable Workspace to anchor a human-scoped Workbench write in (the connector
   * and wallet rows still carry a workspace_id column). The screen supplies none,
   * so resolve the viewer's own earliest Workspace membership rather than trust a
   * client value. Throws only when the account belongs to no Workspace at all.
   */
  private async viewerWorkbenchWorkspace(viewerId: string): Promise<string> {
    const row = await this.database.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM memberships
        WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL
        ORDER BY joined_at, workspace_id LIMIT 1`,
      [viewerId],
    );
    const workspaceId = row.rows[0]?.workspace_id;
    if (!workspaceId) throw new Error('no Workspace for this account');
    return workspaceId;
  }

  /**
   * Every read here is scoped to the VIEWER and to nobody else.
   *
   * The Workbench is a property of the HUMAN, not of a workspace: it lives in
   * personal settings, which cross workspace boundaries, and a paired tool and
   * its keys belong to the person who provisioned them wherever they are
   * working. `workspace_connections` was always keyed on `owner_identity_id`
   * alone; only the connector half carried a workspace, which made the screen
   * demand a workspace id no caller had and gave a person a separate helper
   * per workspace. Read both halves by owner. `input.workspaceId` is accepted
   * and ignored for wire compatibility with clients that still send it.
   */
  async readWorkbench(
    input: Input<'readWorkbench'>,
    viewerId: string,
  ): Promise<Output<'readWorkbench'>> {
    if (input.refreshVault) {
      const refreshes = await this.database.transaction(async (database) => {
        const rows = (
          await database.query<{ id: string; helper_agent_id: string }>(
            `UPDATE workspace_connectors
             SET pending_ops=CASE
                   WHEN pending_ops @> '"sync"'::jsonb THEN pending_ops
                   ELSE pending_ops || '"sync"'::jsonb
                 END,
                 updated_at=now()
             WHERE owner_identity_id=$1 AND connector_type='trusty-squire'
               AND status='connected'
             RETURNING id,helper_agent_id`,
            [viewerId],
          )
        ).rows;
        if (rows.length) {
          await database.query(
            `UPDATE workspace_connections SET last_synced_at=NULL,updated_at=now()
             WHERE connector_id=ANY($1::uuid[])`,
            [rows.map((row) => row.id)],
          );
        }
        return rows;
      });
      // The helper's live assignment wake makes the sync immediate; its
      // ordinary five-minute poll remains the recovery path.
      for (const helperId of new Set(refreshes.map((row) => row.helper_agent_id))) {
        await notifyConnectorAssignment(this.database, helperId);
      }
    }
    const connectors = (
      await this.database.query<{
        id: string;
        connector_type: Input<'pairConnector'>['connectorType'];
        status: ConnectorStatus['status'];
        status_steps: ConnectorStep[];
        status_error: string | null;
        helper_agent_id: string;
        helper_name: string | null;
        squire_version: string | null;
        signed_in_as: string | null;
        sign_in: ConnectorStatus['signIn'] | null;
        composio_scope: unknown;
        connected_at: Date | null;
        created_at: Date;
      }>(
        `SELECT c.id,c.connector_type,c.status,c.status_steps,c.status_error,
                c.helper_agent_id,
                COALESCE((SELECT MAX(sibling.machine_name) FROM agents sibling
                          WHERE sibling.machine_id=c.machine_id
                            AND sibling.owner_id=c.owner_identity_id),i.name) helper_name,
                c.squire_version,
                c.signed_in_as,c.sign_in,c.composio_scope,c.connected_at,c.created_at
         FROM workspace_connectors c
         JOIN identities i ON i.id=c.helper_agent_id
         WHERE c.owner_identity_id=$1
         ORDER BY c.created_at`,
        [viewerId],
      )
    ).rows;
    const connections = (
      await this.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string | null;
        label: string | null;
        hosts: string[];
        state: 'active' | 'error';
        connection_metadata: Record<string, unknown>;
        last_synced_at: Date | null;
        created_at: Date;
      }>(
        // KEYS reads newest-first the way the Squire vault itself lists them,
        // so the vault's own `createdAt` orders the rows; ordering by service
        // instead floated four unrelated `default` labels to the top. A 0 is
        // "no vault time" (an unparseable timestamp), which falls back to the
        // row's own insert time rather than sinking the key to the bottom.
        `SELECT id,connector_id,reference,service,label,hosts,state,connection_metadata,last_synced_at,created_at
         FROM workspace_connections
         WHERE owner_identity_id=$1
         ORDER BY COALESCE(NULLIF((connection_metadata->>'vaultCreatedAt')::double precision, 0), extract(epoch from created_at)) DESC, reference`,
        [viewerId],
      )
    ).rows;
    const helpers = (
      await this.database.query<{
        id: string;
        name: string;
        online: boolean;
      }>(
        // A helper is a MACHINE, not an individual agent: agents sharing a
        // machine_id are grouped into one row. An agent without a machine_id
        // (pre-migration legacy) is its own machine. Online is true when ANY
        // agent on that machine has recent durable presence evidence (the
        // same 90-second window readers use). Name is the machine_name if set,
        // falling back to the first agent's identity name.
        `SELECT COALESCE(a.machine_id,a.agent_id) id,
                COALESCE(MAX(a.machine_name),MIN(i.name)) name,
                bool_or(p.online) online
         FROM agents a
         JOIN identities i ON i.id=a.agent_id
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.room_id IS NULL AND m.removed_at IS NULL
         LEFT JOIN LATERAL(
           SELECT EXISTS(
             SELECT 1 FROM live_outputs p
             WHERE p.agent_id=a.agent_id AND p.kind='presence'
               AND p.body->>'status'='online'
               AND p.updated_at>now()-interval '90 seconds'
           ) online
         ) p ON true
         WHERE a.owner_id=$1
         GROUP BY COALESCE(a.machine_id,a.agent_id)
         ORDER BY name`,
        [viewerId],
      )
    ).rows;

    const walletRow = (
      await this.database.query<{ created_at: Date; delegation_expires_at: Date | null }>(
        `SELECT created_at,delegation_expires_at FROM wallet_bindings WHERE identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    return {
      workspaceId: input.workspaceId,
      catalog: connectorCatalog().map((entry) =>
        (isGoogleToolConnectorKind(entry.connectorType) && !this.googleOAuth) ||
        (entry.connectorType === 'composio' && !composioScopeForOwner(viewerId))
          ? { ...entry, available: false }
          : entry.connectorType === 'composio'
            ? {
                ...entry,
                approvedTools: Object.values(composioScopeForOwner(viewerId)!.tools).flat(),
              }
            : entry,
      ),
      ...(walletRow
        ? {
            wallet: {
              createdAt: seconds(walletRow.created_at),
              delegationActive:
                walletRow.delegation_expires_at !== null &&
                walletRow.delegation_expires_at.getTime() > Date.now(),
              delegationExpiresAt: walletRow.delegation_expires_at
                ? seconds(walletRow.delegation_expires_at)
                : null,
            },
          }
        : {}),
      helpers: helpers.map((row) => ({
        id: row.id,
        name: row.name,
        online: row.online,
      })),
      connectors: connectors.map((row) => ({
        connectorId: row.id,
        connectorType: row.connector_type,
        status: {
          connectorId: row.id,
          status: row.status,
          steps: row.status_steps ?? [],
          ...(row.helper_name ? { helperName: row.helper_name } : {}),
          ...(row.signed_in_as ? { signedInAs: row.signed_in_as } : {}),
          ...(row.squire_version ? { squireVersion: row.squire_version } : {}),
          ...(row.sign_in ? { signIn: row.sign_in } : {}),
          ...(row.status_error ? { errorMessage: row.status_error } : {}),
        } as ConnectorStatus,
        helperAgentId: row.helper_agent_id,
        ...(row.connector_type === 'composio'
          ? { approvedTools: approvedComposioTools(row.composio_scope, viewerId) }
          : {}),
        ...(row.connected_at ? { connectedAt: seconds(row.connected_at) } : {}),
        createdAt: seconds(row.created_at),
      })),
      connections: connections.map((row) => ({
        connectionId: row.id,
        connectorId: row.connector_id,
        reference: row.reference,
        service: row.service,
        label: row.label ?? row.reference,
        allowedHosts: row.hosts ?? [],
        fieldNames: Array.isArray(row.connection_metadata.fieldNames)
          ? row.connection_metadata.fieldNames.filter(
              (field): field is string => typeof field === 'string',
            )
          : [],
        faviconDomain: faviconDomain(row.hosts ?? []),
        state: row.state,
        ...(row.last_synced_at
          ? {
              lastSyncedAt: seconds(row.last_synced_at),
              ...(isMetadataStale(row.last_synced_at) ? { stale: true } : {}),
            }
          : { stale: true }),
        createdAt:
          typeof row.connection_metadata.vaultCreatedAt === 'number' &&
          Number.isFinite(row.connection_metadata.vaultCreatedAt) &&
          row.connection_metadata.vaultCreatedAt > 0
            ? row.connection_metadata.vaultCreatedAt
            : seconds(row.created_at),
      })),
    };
  }

  async pairConnector(
    input: Input<'pairConnector'>,
    viewerId: string,
  ): Promise<Output<'pairConnector'>> {
    if (!isConnectableConnector(input.connectorType))
      throw new Error(`${connectorDisplayName(input.connectorType)} is not connectable yet`);
    // The input helperAgentId may be a machine_id (from a new client) or an
    // agent_id (back-compat from an older client). Resolve it to a machine:
    // if it matches an agent's machine_id, use that machine; otherwise treat
    // it as an agent_id and find its machine (for legacy agents, machine_id
    // IS the agent_id).
    // The input helperAgentId may be a machine_id or an agent_id.
    // A machine can host several agents, while the connector queue is bound
    // to one exact agent. Prefer the agent with the freshest live presence;
    // otherwise an online machine can arm an offline sibling and leave the
    // install row pending forever. The null fallback preserves old direct
    // callers that paired a legacy agent before presence was available.
    const candidate = await this.database.query<{
      agent_id: string;
      machine_id: string | null;
    }>(
      `SELECT a.agent_id,a.machine_id
         FROM agents a
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.room_id IS NULL AND m.removed_at IS NULL
         LEFT JOIN LATERAL(
           SELECT p.updated_at
           FROM live_outputs p
           WHERE p.agent_id=a.agent_id AND p.kind='presence'
             AND p.body->>'status'='online'
             AND p.updated_at>now()-interval '90 seconds'
           ORDER BY p.updated_at DESC LIMIT 1
         ) presence ON true
        WHERE a.owner_id=$1 AND (a.machine_id=$2 OR a.agent_id=$2)
        ORDER BY presence.updated_at DESC NULLS LAST,a.agent_id
        LIMIT 1`,
      [viewerId, input.helperAgentId],
    );
    const matched = candidate.rows[0];
    if (!matched)
      throw new Error('the connector helper must be a current agent you share a Workspace with');
    const machineId = matched.machine_id ?? matched.agent_id;
    const machine = await this.database.query<{ workspace_id: string }>(
      `SELECT mv.workspace_id
         FROM memberships mv
        WHERE mv.room_id IS NULL AND mv.removed_at IS NULL AND mv.identity_id=$1
          AND EXISTS(
            SELECT 1 FROM memberships mh
            WHERE mh.workspace_id=mv.workspace_id AND mh.room_id IS NULL
              AND mh.removed_at IS NULL AND mh.identity_id=$2
          )
        ORDER BY mv.joined_at, mv.workspace_id LIMIT 1`,
      [viewerId, matched.agent_id],
    );
    const ws = machine.rows[0];
    if (!ws)
      throw new Error('the connector helper must be a current agent you share a Workspace with');
    return this.database.transaction((database) =>
      this.armConnectorPairing(database, {
        workspaceId: ws.workspace_id,
        ownerIdentityId: viewerId,
        connectorType: input.connectorType,
        helperAgentId: matched.agent_id,
        machineId,
      }),
    );
  }

  /**
   * The one row write behind every pairing: the Workbench page's Connect
   * (`pairConnector`, where the person picks one of their own machines) and an
   * accepted connector offer (`acceptConnectorOffer`, where the machine is the
   * offering agent's). Adapted kinds refuse an acceptor who does not own that
   * helper, so a foreign Workbench row cannot inherit its vault. Authorization
   * is otherwise the caller's; this arms the row the helper daemon derives its
   * install from and opens the status DM.
   */
  private async armConnectorPairing(
    database: SqlDatabase,
    input: {
      workspaceId: string;
      ownerIdentityId: string;
      connectorType: Input<'pairConnector'>['connectorType'];
      helperAgentId: string;
      machineId: string;
    },
  ): Promise<Output<'pairConnector'>> {
    const composioScope =
      input.connectorType === 'composio' ? composioScopeForOwner(input.ownerIdentityId) : undefined;
    if (input.connectorType === 'composio' && !composioScope)
      throw new Error('Composio scope is not configured on this Beeline server');
    if (isGoogleToolConnectorKind(input.connectorType) && !this.googleOAuth)
      throw new Error('Google OAuth is not configured on this Beeline server');
    const adapter = connectorAdapter(input.connectorType);
    if (adapter) {
      const helperOwner = (
        await database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`,
          [input.helperAgentId],
        )
      ).rows[0];
      const role = connectorRequesterRole(input.ownerIdentityId, helperOwner?.owner_id ?? '');
      if (!adapter.authorize('connect', role).allowed) throw new Error(CONNECTOR_ADAPTER_DENIED);
    }
    const viewerId = input.ownerIdentityId;
    const machineId = input.machineId;
    const ws = { workspace_id: input.workspaceId };
    const matched = { agent_id: input.helperAgentId };
    const id = randomUUID();
    const previousGoogleStatus = isGoogleToolConnectorKind(input.connectorType)
      ? (
          await database.query<{ status: string }>(
            `SELECT status FROM workspace_connectors
           WHERE workspace_id=$1 AND owner_identity_id=$2
             AND connector_type=$3 AND machine_id=$4`,
            [ws.workspace_id, viewerId, input.connectorType, machineId],
          )
        ).rows[0]?.status
      : undefined;
    await database.query(
      `INSERT INTO workspace_connectors(
         id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,
         status,status_steps,pairing_generation,composio_scope
       ) VALUES ($1,$2,$3,$4,$5,$6,'installing',$7::jsonb,1,$8::jsonb)
       ON CONFLICT (workspace_id,owner_identity_id,connector_type,machine_id) DO UPDATE
       SET helper_agent_id=EXCLUDED.helper_agent_id,
           status='installing',
           status_steps=EXCLUDED.status_steps,
           status_error=CASE WHEN EXCLUDED.connector_type LIKE 'google-%'
             THEN workspace_connectors.status_error ELSE NULL END,
           pending_ops='[]'::jsonb,
           connected_at=NULL,
           sign_in=NULL,
           composio_session_id=CASE WHEN EXCLUDED.connector_type='composio'
             THEN NULL ELSE workspace_connectors.composio_session_id END,
           composio_link_toolkit=NULL,
           composio_ready=false,
           composio_link_started_at=NULL,
           composio_scope=EXCLUDED.composio_scope,
           pairing_generation=workspace_connectors.pairing_generation + 1,
           updated_at=now()`,
      [
        id,
        ws.workspace_id,
        viewerId,
        input.connectorType,
        matched.agent_id,
        machineId,
        JSON.stringify(
          input.connectorType === 'composio'
            ? [
                { label: 'Prepare Composio session', status: 'pending' },
                { label: 'Link account', status: 'pending' },
              ]
            : defaultConnectorSteps(),
        ),
        composioScope ? JSON.stringify(composioScope) : null,
      ],
    );
    // A conflicting row (a previous pairing of the same connector on the same
    // machine — a stale disconnected row, or a connected one being re-paired)
    // is re-armed above exactly like a fresh insert: the mobile poll sees
    // `installing` with default steps again, and the helper daemon — which
    // derives its assignments from `status` AND `helper_agent_id` — is woken
    // by `connector-assignment` (the 5-minute poll is only recovery) even when
    // the conflict row carried a different agent of the same machine or a
    // leftover `uninstall` op.
    const existing = (
      await database.query<{
        id: string;
        status: ConnectorStatus['status'];
        status_steps: ConnectorStep[] | null;
        status_error: string | null;
      }>(
        `SELECT id,status,status_steps,status_error FROM workspace_connectors
           WHERE workspace_id=$1 AND owner_identity_id=$2
             AND connector_type=$3 AND machine_id=$4`,
        [ws.workspace_id, viewerId, input.connectorType, machineId],
      )
    ).rows[0] ?? {
      id,
      status: 'installing' as const,
      status_steps: defaultConnectorSteps() as ConnectorStep[],
      status_error: null,
    };
    if (isGoogleToolConnectorKind(input.connectorType) && this.googleOAuth) {
      if (
        previousGoogleStatus === 'error' ||
        !(await this.googleOAuth.hasGrant(ws.workspace_id, viewerId, machineId, database))
      ) {
        const url = await this.googleOAuth.begin(existing.id, database);
        await database.query(`UPDATE workspace_connectors SET sign_in=$2::jsonb WHERE id=$1`, [
          existing.id,
          JSON.stringify({ method: 'oauth', url }),
        ]);
      }
    }
    // Push the install to this helper now; the poll is only recovery.
    await notifyConnectorAssignment(database, matched.agent_id);
    await ensureConnectorDirectMessageRoom(
      database,
      ws.workspace_id,
      input.connectorType,
      viewerId,
    );
    if (input.connectorType === 'trusty-squire') {
      await grantSquireToOwnerMachineAgents(database, {
        workspaceId: ws.workspace_id,
        ownerIdentityId: viewerId,
        machineId,
      });
    }
    return {
      connectorId: existing.id,
      status: {
        connectorId: existing.id,
        status: existing.status,
        steps: existing.status_steps ?? [],
        ...(existing.status_error ? { errorMessage: existing.status_error } : {}),
      } as ConnectorStatus,
    };
  }

  private async assertOwnedConnector(connectorId: string, viewerId: string) {
    // Human-scoped: a connector is owned by the viewer. Adapted kinds
    // (Squire, YouTube) take that verdict from the typed adapter so
    // cross-requester disconnect is the adapter's refusal, not a second rule.
    const row = await this.database.query<{
      id: string;
      connector_type: Input<'pairConnector'>['connectorType'];
      status: string;
      helper_agent_id: string;
      owner_identity_id: string;
    }>(
      `SELECT id,connector_type,status,helper_agent_id,owner_identity_id
       FROM workspace_connectors WHERE id=$1::uuid`,
      [connectorId],
    );
    if (!row.rowCount) throw new Error('connector not found (access denied)');
    const connector = row.rows[0]!;
    const adapter = connectorAdapter(connector.connector_type);
    if (adapter) {
      const role = connectorRequesterRole(viewerId, connector.owner_identity_id);
      if (!adapter.authorize('disconnect', role).allowed)
        throw new Error('connector not found (access denied)');
      return connector;
    }
    if (connector.owner_identity_id !== viewerId)
      throw new Error('connector not found (access denied)');
    return connector;
  }

  /** Unpair revokes everything the helper holds, then waits for its uninstall ack. */
  async unpairConnector(input: Input<'unpairConnector'>, viewerId: string): Promise<void> {
    await this.assertWorkbenchViewer(input.workspaceId, viewerId);
    const connector = await this.assertOwnedConnector(input.connectorId, viewerId);
    // Receipts and connections are the connector's work; unpair clears them.
    await this.database.query(`DELETE FROM workspace_connections WHERE connector_id=$1::uuid`, [
      input.connectorId,
    ]);
    await this.database.query(
      `UPDATE workspace_connectors
       SET status='disconnected', status_steps='[]'::jsonb, status_error=NULL,
           pending_ops='[]'::jsonb, connected_at=NULL, updated_at=now()
       WHERE id=$1::uuid`,
      [input.connectorId],
    );
    if (isGoogleToolConnectorKind(connector.connector_type)) {
      await this.database.query(
        `DELETE FROM google_oauth_grants g
         USING workspace_connectors c
         WHERE c.id=$1 AND g.workspace_id=c.workspace_id
           AND g.owner_identity_id=c.owner_identity_id AND g.machine_id=c.machine_id
           AND NOT EXISTS (
             SELECT 1 FROM workspace_connectors active
             WHERE active.workspace_id=c.workspace_id
               AND active.owner_identity_id=c.owner_identity_id
               AND active.machine_id=c.machine_id
               AND active.connector_type LIKE 'google-%'
               AND active.status IN ('installing','connected','error')
           )`,
        [input.connectorId],
      );
    }
    await notifyConnectorAssignment(this.database, connector.helper_agent_id);
  }

  async readConnectionDetail(
    input: Input<'readConnectionDetail'>,
    viewerId: string,
  ): Promise<Output<'readConnectionDetail'>> {
    await this.assertWorkbenchViewer(input.workspaceId, viewerId);
    const connection = (
      await this.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string;
        label: string | null;
        hosts: string[];
        state: 'active' | 'error';
        grants: unknown[];
        connection_metadata: Record<string, unknown>;
        last_synced_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id,connector_id,reference,service,label,hosts,state,grants,
                connection_metadata,last_synced_at,created_at
         FROM workspace_connections WHERE id=$1::uuid AND owner_identity_id=$2`,
        [input.connectionId, viewerId],
      )
    ).rows[0];
    if (!connection) throw new Error('connection not found (access denied)');
    // Live detail reads: cached provider metadata older than the TTL queues a
    // `sync` op and wakes the helper for a fresh snapshot now; its recovery
    // poll only catches a wake that reached no socket.
    if (isMetadataStale(connection.last_synced_at)) {
      await this.database.query(
        `UPDATE workspace_connectors
         SET pending_ops = pending_ops || '"sync"'::jsonb, updated_at=now()
         WHERE id=$1::uuid AND NOT pending_ops @> '"sync"'::jsonb`,
        [connection.connector_id],
      );
      await notifyConnectorHelper(this.database, connection.connector_id);
    }
    const ledger = (
      await this.database.query<{
        id: string;
        agent_name: string | null;
        operation: string;
        status_code: number | null;
        bytes: string;
        grant_info: string | null;
        created_at: Date;
      }>(
        `SELECT r.id,r.operation,r.status_code,r.bytes,r.grant_info,r.created_at,
                i.name agent_name
         FROM connection_receipts r
         LEFT JOIN identities i ON i.id=r.agent_id
         WHERE r.connection_id=$1::uuid
         ORDER BY r.created_at DESC LIMIT 50`,
        [connection.id],
      )
    ).rows;
    return {
      connection: {
        connectionId: connection.id,
        connectorId: connection.connector_id,
        reference: connection.reference,
        service: connection.service,
        label: connection.label ?? connection.reference,
        allowedHosts: connection.hosts ?? [],
        fieldNames: Array.isArray(connection.connection_metadata.fieldNames)
          ? connection.connection_metadata.fieldNames.filter(
              (field): field is string => typeof field === 'string',
            )
          : [],
        faviconDomain: faviconDomain(connection.hosts ?? []),
        state: connection.state,
        ...(connection.last_synced_at
          ? {
              lastSyncedAt: seconds(connection.last_synced_at),
              ...(isMetadataStale(connection.last_synced_at) ? { stale: true } : {}),
            }
          : { stale: true }),
        createdAt:
          typeof connection.connection_metadata.vaultCreatedAt === 'number' &&
          Number.isFinite(connection.connection_metadata.vaultCreatedAt) &&
          connection.connection_metadata.vaultCreatedAt > 0
            ? connection.connection_metadata.vaultCreatedAt
            : seconds(connection.created_at),
      },
      grants: (connection.grants ?? []) as Output<'readConnectionDetail'>['grants'],
      ledger: ledger.map((row) => ({
        id: row.id,
        ...(row.agent_name ? { agentName: row.agent_name } : {}),
        operation: row.operation,
        ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
        ...(Number(row.bytes) > 0 ? { bytes: Number(row.bytes) } : {}),
        ...(row.grant_info ? { grant: row.grant_info } : {}),
        createdAt: seconds(row.created_at),
      })),
    };
  }

  async revokeConnectionGrants(
    input: Input<'revokeConnectionGrants'>,
    viewerId: string,
  ): Promise<Output<'revokeConnectionGrants'>> {
    await this.assertWorkbenchViewer(input.workspaceId, viewerId);
    const connection = (
      await this.database.query<{
        id: string;
        connector_id: string;
        connector_type: Input<'pairConnector'>['connectorType'];
        reference: string;
        grants: Array<Record<string, unknown>>;
        owner_identity_id: string;
      }>(
        `SELECT c.id,c.connector_id,k.connector_type,c.reference,c.grants,
                c.owner_identity_id
         FROM workspace_connections c
         JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE c.id=$1::uuid`,
        [input.connectionId],
      )
    ).rows[0];
    if (!connection) throw new Error('connection not found (access denied)');
    const adapter = connectorAdapter(connection.connector_type);
    const role = connectorRequesterRole(viewerId, connection.owner_identity_id);
    if (adapter) {
      if (!adapter.authorize('revoke-grants', role).allowed)
        throw new Error('connection not found (access denied)');
    } else if (connection.owner_identity_id !== viewerId) {
      throw new Error('connection not found (access denied)');
    }
    const live = (connection.grants ?? []).filter((grant) => !grant.revokedAt && !grant.revokingAt);
    const alreadyPending = (connection.grants ?? []).filter(
      (grant) => !grant.revokedAt && grant.revokingAt,
    ).length;
    const revokingAt = Math.floor(Date.now() / 1000);
    const updated = (connection.grants ?? []).map((grant) =>
      grant.revokedAt || grant.revokingAt ? grant : { ...grant, revokingAt },
    );
    await this.database.query(
      `UPDATE workspace_connections SET grants=$2::jsonb, updated_at=now() WHERE id=$1::uuid`,
      [connection.id, JSON.stringify(updated)],
    );
    if (live.length) {
      await this.database.query(
        `UPDATE workspace_connectors
         SET pending_ops = pending_ops || $2::jsonb, updated_at=now()
         WHERE id=$1::uuid`,
        [connection.connector_id, JSON.stringify([`revoke-grants:${connection.reference}`])],
      );
      await notifyConnectorHelper(this.database, connection.connector_id);
    }
    const pending = live.length + alreadyPending;
    return pending ? { revoked: 0, failed: 0, pending } : { revoked: 0, failed: 0 };
  }

  private async assertRoomIsWritable(roomId: string, author: string): Promise<void> {
    if (author === SYSTEM_IDENTITY_ID) return;
    const room = await this.database.query<{ direct_participants: string[] | null }>(
      `SELECT direct_participants FROM rooms WHERE id=$1`,
      [roomId],
    );
    const participants = room.rows[0]?.direct_participants ?? null;
    if (participants?.includes(SYSTEM_IDENTITY_ID)) {
      throw new Error(
        'this is a read-only system announcements channel; only @system may post here (access denied)',
      );
    }
    if (dmParticipantsIncludeConnectorIdentity(participants)) {
      throw new Error(
        'this is a read-only connector receipts channel; only the connector identity may post here (access denied)',
      );
    }
  }
  private async requireRoomWorkspaceManager(roomId: string, identityId: string) {
    const row = await this.database.query(
      `SELECT 1 FROM rooms room
       JOIN memberships membership ON membership.workspace_id=room.workspace_id
         AND membership.room_id IS NULL AND membership.identity_id=$2
         AND membership.role IN ('owner','admin') AND membership.removed_at IS NULL
       WHERE room.id=$1`,
      [roomId, identityId],
    );
    if (!row.rowCount) throw new Error('room manager required');
  }
  private async requireHumanRoomWorkspaceManager(roomId: string, identityId: string) {
    const row = await this.database.query(
      `SELECT 1 FROM rooms room
       JOIN memberships membership ON membership.workspace_id=room.workspace_id
         AND membership.room_id IS NULL AND membership.identity_id=$2
         AND membership.role IN ('owner','admin') AND membership.removed_at IS NULL
       JOIN identities identity ON identity.id=membership.identity_id AND identity.kind='human'
       WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL`,
      [roomId, identityId],
    );
    if (!row.rowCount) throw new Error('room manager required');
  }
  private async requireTopLevelChatMember(
    roomId: string,
    identityId: string,
    database = this.database,
  ) {
    const row = await database.query(
      `SELECT 1 FROM rooms room
       JOIN memberships membership ON membership.room_id=room.id
         AND membership.identity_id=$2 AND membership.removed_at IS NULL
       WHERE room.id=$1 AND room.parent_id IS NULL AND room.archived_at IS NULL
       FOR SHARE OF room,membership`,
      [roomId, identityId],
    );
    if (!row.rowCount) throw new Error('chat membership required');
  }
  private async requireTopLevelRoom(roomId: string) {
    const room = (
      await this.database.query<{
        workspace_id: string;
        parent_id: string | null;
        direct_participants: string[] | null;
        archived_at: Date | null;
        visibility: 'public' | 'invite-only';
      }>(
        `SELECT workspace_id,parent_id,direct_participants,archived_at,visibility FROM rooms WHERE id=$1`,
        [roomId],
      )
    ).rows[0];
    if (!room) throw new Error('room not found');
    if (room.parent_id) throw new Error('room lifecycle cannot target a corner');
    if (room.direct_participants) throw new Error('direct-message membership is immutable');
    if (room.archived_at) throw new Error('room is archived');
    return room;
  }
  private async requireWorkspaceManager(
    workspaceId: string,
    identityId: string,
    database = this.database,
  ) {
    const row = await database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND role IN ('owner','admin') AND removed_at IS NULL`,
      [workspaceId, identityId],
    );
    if (!row.rowCount) throw new Error('workspace manager required');
  }
  /** Owner-only: stricter than requireWorkspaceManager (owner|admin), for the
   *  one action an admin may never take — deleting the whole workspace. */
  private async requireWorkspaceOwner(
    workspaceId: string,
    identityId: string,
    database = this.database,
  ) {
    const row = await database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND role='owner' AND removed_at IS NULL`,
      [workspaceId, identityId],
    );
    if (!row.rowCount) throw new Error('workspace owner access denied');
  }

  private rosterSearchNeedle(query: string | undefined): string | null {
    const needle = query?.trim().toLowerCase() ?? '';
    return needle ? needle.slice(0, 80) : null;
  }

  private async workspaceRosterPage(
    workspaceId: string,
    kind: 'human' | 'agent',
    needle: string | null,
    offset: number,
    ownerId?: string,
  ): Promise<{ rows: MemberRow[]; total: number; truncated: boolean }> {
    const rows = await this.database.query<MemberRow & { kind_total: string }>(
      `SELECT i.id,
         i.kind,i.name,i.handle,i.avatar,
         i.face_id,
         m.role,NULL::jsonb presence_body,NULL::timestamptz presence_updated_at,
         count(*) OVER ()::text AS kind_total
       FROM memberships m JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND i.hidden_from_roster=false AND i.kind=$2
         AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM agents owned WHERE owned.agent_id=i.id AND owned.owner_id=$6))
         AND (
           $3::text IS NULL
           OR position($3 in lower(i.name)) > 0
           OR position($3 in lower(COALESCE(i.handle, ''))) > 0
         )
       ORDER BY CASE WHEN $2='human' AND m.role='owner' THEN 0 ELSE 1 END,
         lower(i.name), i.id
       LIMIT $4 OFFSET $5`,
      [workspaceId, kind, needle, WORKSPACE_MEMBER_PAGE_SIZE + 1, offset, ownerId ?? null],
    );
    const truncated = rows.rows.length > WORKSPACE_MEMBER_PAGE_SIZE;
    const page = rows.rows.slice(0, WORKSPACE_MEMBER_PAGE_SIZE);
    return {
      rows: page,
      total: Number(page[0]?.kind_total ?? rows.rows[0]?.kind_total ?? 0),
      truncated,
    };
  }

  private async enrichWorkspaceAgents(
    members: readonly RoomViewMember[],
  ): Promise<WorkspaceAgentView[]> {
    const agentMembers = members.filter((member) => member.identity.kind === 'agent');
    if (!agentMembers.length) return [];
    const configs = await this.database.query<{
      agent_id: string;
      selected_model: string | null;
      model_catalog: AgentDetailView['catalog'];
      owner_id: string;
      owner_name: string;
      owner_handle: string | null;
    }>(
      `SELECT agent.agent_id,agent.selected_model,agent.model_catalog,
              owner.id owner_id,owner.name owner_name,owner.handle owner_handle
       FROM agents agent JOIN identities owner ON owner.id=agent.owner_id
       WHERE agent.agent_id=ANY($1::text[])`,
      [agentMembers.map((member) => member.identity.pubkey)],
    );
    const configByAgent = new Map(configs.rows.map((config) => [config.agent_id, config]));
    return agentMembers.map((member) => {
      const config = configByAgent.get(member.identity.pubkey);
      const model = config
        ? selectedModelLabel(config.selected_model, config.model_catalog ?? [])
        : undefined;
      return {
        ...member,
        ...(model ? { model } : {}),
        ...(config
          ? {
              owner: {
                pubkey: config.owner_id,
                kind: 'human' as const,
                name: config.owner_name,
                ...(config.owner_handle ? { handle: config.owner_handle } : {}),
              },
            }
          : {}),
      };
    });
  }

  private async workspaceRosterCount(
    workspaceId: string,
    kind: 'human' | 'agent',
    needle: string | null,
  ): Promise<number> {
    const rows = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM memberships m JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND i.hidden_from_roster=false AND i.kind=$2
         AND (
           $3::text IS NULL
           OR position($3 in lower(i.name)) > 0
           OR position($3 in lower(COALESCE(i.handle, ''))) > 0
         )`,
      [workspaceId, kind, needle],
    );
    return Number(rows.rows[0]?.total ?? 0);
  }

  private async workspaceRoster(
    workspaceId: string,
    query: WorkspaceMemberListQuery = {},
  ): Promise<WorkspaceMemberListView> {
    const needle = this.rosterSearchNeedle(query.q);
    const offset =
      Number.isSafeInteger(query.offset) && (query.offset ?? 0) > 0 ? query.offset! : 0;
    const kind = query.kind === 'human' || query.kind === 'agent' ? query.kind : undefined;
    const loadPeople = kind !== 'agent';
    const loadAgents = kind !== 'human';
    const [peoplePage, agentPage] = await Promise.all([
      loadPeople
        ? this.workspaceRosterPage(workspaceId, 'human', needle, kind === 'human' ? offset : 0)
        : Promise.resolve({ rows: [] as MemberRow[], total: 0, truncated: false }),
      loadAgents
        ? this.workspaceRosterPage(
            workspaceId,
            'agent',
            needle,
            kind === 'agent' ? offset : 0,
            query.ownerId,
          )
        : Promise.resolve({ rows: [] as MemberRow[], total: 0, truncated: false }),
    ]);
    const pageRows = [...peoplePage.rows, ...agentPage.rows];
    const presenceIds = pageRows.map((row) => row.id);
    if (presenceIds.length) {
      const presence = await this.optionalEnrichment(
        'member-presence',
        this.enrichmentDatabase.query<{
          id: string;
          presence_body: MemberRow['presence_body'];
          presence_updated_at: Date;
        }>(
          `SELECT member.identity_id id,presence.body presence_body,
             presence.updated_at presence_updated_at
           FROM memberships member
           JOIN LATERAL(
             SELECT body,updated_at FROM live_outputs
             WHERE agent_id=member.identity_id AND kind='presence'
             ORDER BY updated_at DESC LIMIT 1
           ) presence ON true
           WHERE member.workspace_id=$1 AND member.room_id IS NULL
             AND member.removed_at IS NULL AND member.identity_id=ANY($2::text[])`,
          [workspaceId, presenceIds],
        ),
      );
      const presenceByMember = new Map(presence?.rows.map((item) => [item.id, item]) ?? []);
      for (const member of pageRows) {
        const item = presenceByMember.get(member.id);
        member.presence_body = item?.presence_body ?? null;
        member.presence_updated_at = item?.presence_updated_at ?? null;
      }
    }
    const people = this.projectMembers(peoplePage.rows, null);
    const agents = await this.enrichWorkspaceAgents(this.projectMembers(agentPage.rows, null));
    const [peopleTotal, agentTotal] = await Promise.all([
      kind === 'agent'
        ? this.workspaceRosterCount(workspaceId, 'human', needle)
        : Promise.resolve(peoplePage.total),
      kind === 'human'
        ? this.workspaceRosterCount(workspaceId, 'agent', needle)
        : Promise.resolve(agentPage.total),
    ]);
    return {
      members: people,
      agents,
      peopleTotal,
      agentTotal,
      membersTruncated: peoplePage.truncated,
      agentsTruncated: agentPage.truncated,
    };
  }

  private async members(
    workspaceId: string,
    roomId: string | null,
    memberId?: string,
  ): Promise<RoomViewMember[]> {
    const rows = await this.database.query<MemberRow>(
      `SELECT i.id,
         i.kind,i.name,i.handle,i.avatar,
         i.face_id,
         m.role,NULL::jsonb presence_body,NULL::timestamptz presence_updated_at
       FROM memberships m JOIN identities i ON i.id=m.identity_id
       WHERE m.workspace_id=$1 AND ($2::uuid IS NULL AND m.room_id IS NULL OR m.room_id=$2)
         AND m.removed_at IS NULL AND i.hidden_from_roster=false
         AND ($3::text IS NULL OR i.id=$3)`,
      [workspaceId, roomId, memberId ?? null],
    );
    const presence = await this.optionalEnrichment(
      'member-presence',
      this.enrichmentDatabase.query<{
        id: string;
        presence_body: MemberRow['presence_body'];
        presence_updated_at: Date;
      }>(
        `SELECT member.identity_id id,presence.body presence_body,
           presence.updated_at presence_updated_at
         FROM memberships member
         JOIN LATERAL(
           SELECT body,updated_at FROM live_outputs
           WHERE agent_id=member.identity_id AND kind='presence'
           ORDER BY updated_at DESC LIMIT 1
         ) presence ON true
         WHERE member.workspace_id=$1 AND ($2::uuid IS NULL AND member.room_id IS NULL OR member.room_id=$2)
           AND member.removed_at IS NULL AND ($3::text IS NULL OR member.identity_id=$3)`,
        [workspaceId, roomId, memberId ?? null],
      ),
    );
    const presenceByMember = new Map(presence?.rows.map((item) => [item.id, item]) ?? []);
    for (const member of rows.rows) {
      const item = presenceByMember.get(member.id);
      member.presence_body = item?.presence_body ?? null;
      member.presence_updated_at = item?.presence_updated_at ?? null;
    }
    return this.projectMembers(rows.rows, roomId);
  }
  private projectMembers(rows: readonly MemberRow[], roomId: string | null): RoomViewMember[] {
    return rows.map((row) => ({
      identity: identity(row, this.publicOrigin),
      role: row.role,
      ...(row.presence_body && row.presence_updated_at
        ? {
            presence: {
              status:
                row.presence_body.status === 'online' &&
                Date.now() - row.presence_updated_at.getTime() < AGENT_REACHABLE_HORIZON_MS
                  ? 'online'
                  : 'offline',
              observedAt: row.presence_body.observedAt,
              ...(roomId ? { roomId } : {}),
            },
          }
        : {}),
    }));
  }
  /**
   * Which media ids referenced by these messages have expired, and which name
   * ready object rows. Two queries per read, both over indexed id sets: expiry
   * is a fact the sweep wrote, and card facts live on the `objects` row.
   */
  private async attachmentFacts(
    ...groups: readonly (readonly RoomViewMessage[])[]
  ): Promise<AttachmentFacts> {
    const ids = new Set<string>();
    for (const messages of groups)
      for (const message of messages)
        for (const attachment of message.attachments ?? []) {
          const id = mediaIdFromUrl(attachment.url);
          if (id) ids.add(id);
        }
    if (!ids.size) return { expired: new Set(), artifacts: new Map() };
    const [expired, objectRows] = await Promise.all([
      this.database.query<{ id: string }>(
        `SELECT id::text id FROM object_expirations WHERE id=ANY($1::uuid[])`,
        [[...ids]],
      ),
      this.database.query<{
        id: string;
        title: string;
        mime: string;
        size: string;
        author: string;
      }>(
        `SELECT o.id::text id,COALESCE(o.title, '') title,o.mime mime,o.size::text size,
                COALESCE(i.handle, i.name) author
         FROM objects o JOIN identities i ON i.id=o.owner_id
         WHERE o.state='ready' AND o.id=ANY($1::uuid[])`,
        [[...ids]],
      ),
    ]);
    return {
      expired: new Set(expired.rows.map((row) => row.id)),
      artifacts: new Map(
        objectRows.rows.map((row) => [
          row.id,
          {
            kind: 'artifact',
            title: row.title,
            mimeType: row.mime,
            size: Number(row.size),
            author: row.author,
          } satisfies ArtifactAttachment,
        ]),
      ),
    };
  }

  private async messageRows(
    roomId: string,
    before: { createdAt: number; id: string } | undefined,
    limit: number,
  ) {
    // `createdAt` is the compatibility display stamp and is rounded to
    // seconds. Resolve the cursor row so siblings stored inside that second
    // cannot disappear between pages.
    const rows = (
      await this.database.query<MessageRow>(
        `SELECT m.*,
           i.kind author_kind,i.name author_name,i.handle author_handle,
           i.avatar author_avatar,i.face_id author_face,
           ${reactionIdentitiesSql('m')} reaction_identities,
           '{}'::text[] tagged_ids
         FROM messages m JOIN identities i ON i.id=m.author_id
         WHERE m.room_id=$1 AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
           AND ${hiddenWakeCardSql('m')}
         ${
           before
             ? `AND (m.created_at,m.id)<(
                  SELECT cursor.created_at,cursor.id FROM messages cursor
                  WHERE cursor.room_id=$1 AND cursor.id=$2
                )`
             : ''
         }
         ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit}`,
        before ? [roomId, before.id] : [roomId],
      )
    ).rows;
    await this.enrichMessageTags(rows);
    return rows;
  }

  private async enrichMessageTags(rows: MessageRow[]): Promise<void> {
    if (!rows.length) return;
    const tags = await this.optionalEnrichment(
      'message-tags',
      this.enrichmentDatabase.query<{ id: string; tagged_ids: string[] }>(
        `SELECT m.id,${taggedIdentityIdsSql('m')} tagged_ids
         FROM messages m WHERE m.id=ANY($1::text[])`,
        [rows.map((message) => message.id)],
      ),
    );
    const tagsByMessage = new Map(tags?.rows.map((item) => [item.id, item.tagged_ids]) ?? []);
    for (const message of rows) message.tagged_ids = tagsByMessage.get(message.id) ?? [];
  }
  private async latestAgentTurns(roomId: string): Promise<RoomView['latestAgentTurns']> {
    // `requested_by` is the command chain's root human requester — the
    // one person who may stop this turn. It is resolved HERE, from the row, and
    // never from the transcript window: a long turn's request scrolls out of
    // that window while it is still running, and a control that disappears
    // because the question scrolled away is a control nobody can rely on. A
    // relayed turn keeps the initiating human through its command chain.
    const turns = await this.database.query<AgentTurnRow>(
      `SELECT DISTINCT ON(turn.agent_id)
         turn.request_id,turn.agent_id,turn.status,turn.started_at,turn.created_at,turn.generation_id,
         requester.id requested_by
       FROM agent_turns turn
       LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('turn')}
       LEFT JOIN identities requester ON requester.id=trigger.author_id AND requester.kind='human'
       WHERE turn.room_id=$1
       ORDER BY turn.agent_id,turn.created_at DESC,turn.request_id DESC`,
      [roomId],
    );
    return this.projectAgentTurns(turns.rows);
  }
  private projectAgentTurns(turns: readonly AgentTurnRow[]): RoomView['latestAgentTurns'] {
    return turns
      .map((turn) => ({
        requestId: turn.request_id,
        agentPubkey: turn.agent_id,
        status: turn.status,
        startedAt: unix(turn.started_at),
        createdAt: unix(turn.created_at),
        ...(turn.generation_id ? { generationId: turn.generation_id } : {}),
        ...(turn.requested_by ? { requestedBy: turn.requested_by } : {}),
      }))
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.agentPubkey.localeCompare(right.agentPubkey),
      )
      .slice(0, ROOM_VIEW_AGENT_LIMIT);
  }
  private async roomMessages(
    roomId: string,
    latestAgentTurns: RoomView['latestAgentTurns'] | Promise<RoomView['latestAgentTurns']>,
    isCorner = false,
    viewerId?: string,
  ): Promise<{ messages: RoomViewMessage[]; toolRows: RoomViewMessage[] }> {
    const eligible = `m.id IN (
      (SELECT raw.id FROM legacy_room_events raw WHERE raw.room_id=$1 AND raw.kind=9
         AND raw.raw_page_candidate=true
       ORDER BY raw.created_at DESC,raw.id ASC LIMIT 180)
      UNION
      (SELECT conversation.id FROM legacy_room_events conversation
       WHERE conversation.room_id=$1 AND conversation.conversation_candidate=true
       ORDER BY conversation.created_at DESC,conversation.id ASC LIMIT 30)
      UNION
      (SELECT plan.id FROM legacy_room_events plan WHERE plan.room_id=$1 AND plan.kind=30078)
    )`;
    const transcriptRowsPromise = this.database.query<MessageRow>(
      `SELECT m.*,
         i.kind author_kind,i.name author_name,i.handle author_handle,
         i.avatar author_avatar,i.face_id author_face,
         ${reactionIdentitiesSql('m')} reaction_identities,
         '{}'::text[] tagged_ids
       FROM messages m JOIN identities i ON i.id=m.author_id
       WHERE m.room_id=$1 AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
         AND ${hiddenWakeCardSql('m')}
         AND (NOT EXISTS(SELECT 1 FROM legacy_room_events any_legacy WHERE any_legacy.room_id=$1) OR ${eligible})
       ORDER BY m.created_at DESC,m.id DESC LIMIT ${ROOM_VIEW_MESSAGE_LIMIT}`,
      [roomId],
    );
    const liveRowsPromise = this.database.query<MessageRow>(
      `SELECT m.*,
         i.kind author_kind,i.name author_name,i.handle author_handle,
         i.avatar author_avatar,i.face_id author_face,
         ${reactionIdentitiesSql('m')} reaction_identities,
         '{}'::text[] tagged_ids
       FROM messages m JOIN identities i ON i.id=m.author_id
       WHERE m.room_id=$1 AND m.presentation='activity' AND m.durable_fact IS NULL
         AND (NOT EXISTS(SELECT 1 FROM legacy_room_events any_legacy WHERE any_legacy.room_id=$1) OR ${eligible})
       ORDER BY m.created_at DESC,m.id DESC`,
      [roomId],
    );
    const cornerActivityRowsPromise = isCorner
      ? this.database.query<MessageRow>(
          `SELECT m.*,
             i.kind author_kind,i.name author_name,i.handle author_handle,
             i.avatar author_avatar,i.face_id author_face,
             ${reactionIdentitiesSql('m')} reaction_identities,
             '{}'::text[] tagged_ids
           FROM messages m JOIN identities i ON i.id=m.author_id
           WHERE m.room_id=$1 AND m.presentation='activity' AND m.durable_fact IS NULL
             AND EXISTS(
               SELECT 1 FROM jsonb_array_elements(m.activity) item
               WHERE item->>'kind' IN ('tool','output')
             )
           ORDER BY m.created_at DESC,m.id DESC LIMIT ${ROOM_VIEW_TOOL_ROW_LIMIT}`,
          [roomId],
        )
      : Promise.resolve({ rows: [] as MessageRow[], rowCount: 0 });
    const [transcriptRows, liveRows, cornerActivityRows, resolvedAgentTurns] = await Promise.all([
      transcriptRowsPromise,
      liveRowsPromise,
      cornerActivityRowsPromise,
      latestAgentTurns,
    ]);
    if (viewerId) {
      await this.enrichMessageBookmarks(
        [...transcriptRows.rows, ...liveRows.rows, ...cornerActivityRows.rows],
        viewerId,
      );
    }
    await this.enrichMessageTags(transcriptRows.rows);
    return this.projectRoomMessages(
      transcriptRows.rows,
      liveRows.rows,
      cornerActivityRows.rows,
      resolvedAgentTurns,
      isCorner,
      viewerId,
    );
  }
  private async enrichMessageBookmarks(
    rows: readonly MessageRow[],
    viewerId: string,
  ): Promise<void> {
    if (!rows.length) return;
    const result = await this.database.query<{ message_id: string }>(
      `SELECT message_id FROM message_bookmarks
       WHERE identity_id=$1 AND message_id=ANY($2::text[])`,
      [viewerId, [...new Set(rows.map((row) => row.id))]],
    );
    const bookmarked = new Set(result.rows.map((row) => row.message_id));
    for (const row of rows) row.bookmarked = bookmarked.has(row.id);
  }
  private projectRoomMessages(
    transcriptRows: readonly MessageRow[],
    liveRows: readonly MessageRow[],
    cornerActivityRows: readonly MessageRow[],
    resolvedAgentTurns: RoomView['latestAgentTurns'],
    isCorner: boolean,
    viewerId?: string,
  ): { messages: RoomViewMessage[]; toolRows: RoomViewMessage[] } {
    const transcript = transcriptRows.map((row) =>
      projectedMessage(row, this.publicOrigin, viewerId),
    );
    const workingByAgent = new Map(
      resolvedAgentTurns
        .filter((turn) => turn.status === 'working')
        .map((turn) => [turn.agentPubkey, turn.createdAt]),
    );
    const liveActivity = liveRows
      .map((row) => projectedMessage(row, this.publicOrigin, viewerId))
      .filter(
        (message) =>
          message.createdAt >=
          (workingByAgent.get(message.author.pubkey) ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, ROOM_VIEW_MESSAGE_LIMIT);
    // Settled corner work rows survive the turn (#804): tools and the agent's
    // own interim prose share the additive activity payload, under its own cap
    // so neither crowds out the message window. The wire field keeps its
    // historical `toolRows` name for compatibility with shipped phones.
    const cornerActivityMessages = cornerActivityRows.map((row) =>
      projectedMessage(row, this.publicOrigin, viewerId),
    );
    const byId = new Map(
      collapsePermissionCards([...transcript.reverse(), ...liveActivity.reverse()]).map(
        (message) => [message.id, message],
      ),
    );
    const merged = [...byId.values()].sort(messageOrder);
    if (!isCorner) return { messages: merged.slice(-ROOM_VIEW_MESSAGE_LIMIT), toolRows: [] };
    // Every Room response stays inside the shared phone message cap. Settled
    // corner tool rows are additive and independently bounded.
    const liveIds = new Set(liveActivity.map((message) => message.id));
    return {
      messages: merged
        .filter(
          (message) =>
            message.presentation !== 'activity' || message.durableFact || liveIds.has(message.id),
        )
        .slice(-ROOM_VIEW_MESSAGE_LIMIT),
      toolRows: cornerActivityMessages,
    };
  }
  private async cornerLifecycle(roomId: string) {
    return (
      (
        await this.database.query<{ lifecycle: NonNullable<RoomView['cornerLifecycle']> }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [roomId],
        )
      ).rows[0]?.lifecycle ?? { lifecycle: 'unknown' as const, checks: 'unknown' as const }
    );
  }
}

/**
 * How a system line names a person: their `@handle`, never a display name.
 *
 * A handle is the address a reader can actually use and it is unique; a display
 * name is neither, and two people can wear the same one. A person with no handle
 * is left unnamed by the caller rather than described by one.
 */
function personMention(handle: string | null | undefined): string | undefined {
  const trimmed = handle?.trim().replace(/^@/, '');
  return trimmed ? `@${trimmed}` : undefined;
}

/** Grant decisions retain the owner-or-Workspace-manager authority axis. */
export const YOLO_AUTHORITY_MESSAGE = "Only the agent's owner or a workspace admin can change this";

/**
 * Who may accept a connector offer (R5, Q4): the person the agent addressed
 * or a Workspace manager. Named here so `server.ts` answers 403.
 */
export const CONNECTOR_OFFER_AUTHORITY_MESSAGE =
  'Only the person the agent addressed or a workspace admin can add this tool';

/** Agent configuration belongs only to the human who connected that agent. */
export const AGENT_OWNER_AUTHORITY_MESSAGE = "Only the agent's owner can change this";

/**
 * A requester or current Room owner/admin may stop a turn.
 * Named here so `server.ts` answers 403 rather than a generic failure.
 */
export const TURN_REQUESTER_AUTHORITY_MESSAGE =
  'Only the requester, Room owner or admin can stop this turn';

/** The same owner-only axis, for who may address an agent. */
export const ACCESS_POLICY_AUTHORITY_MESSAGE = AGENT_OWNER_AUTHORITY_MESSAGE;

/**
 * The Google Play review identity signs in without GitHub, so it holds no
 * GitHub token and must never acquire one: it cannot install the App, create or
 * link a repository, or bind itself to a GitHub account. Read-only repository
 * operations stay available and simply answer empty. This is the one place the
 * review identity differs from an ordinary person.
 */
export const REVIEW_IDENTITY_MESSAGE = 'GitHub access denied for the review identity';
export const REVIEW_LOCKED_OPERATIONS = new Set<keyof PhoneOperationMap>([
  'setRoomRepository',
  'removeRoomRepository',
  'beginGitHubInstallation',
  'createGitHubRepository',
  'beginGitHubIdentityBind',
  'completeGitHubIdentityBind',
  'recoverGitHubIdentity',
  'adoptGitHubHandle',
  'dispatchRoomWorkflow',
]);

export const PHONE_OPERATION_NAMES = new Set<keyof PhoneOperationMap>([
  'sendRoomMessage',
  'sendRoomReply',
  'reactToMessage',
  'deleteRoomMessage',
  'setMessageBookmark',
  'listMessageBookmarks',
  'createRoomSchedule',
  'listRoomSchedules',
  'deleteRoomSchedule',
  'cancelAgentTurn',
  'createHumanCorner',
  'requestCornerClose',
  'decideWritePermission',
  'decideAgentGrant',
  'revokeAgentGrant',
  'acceptConnectorOffer',
  'createRoomPoll',
  'answerChoice',
  'skipChoice',
  'createWorkspace',
  'updateWorkspace',
  'leaveWorkspace',
  'deleteWorkspace',
  'addWorkspaceMember',
  'removeWorkspaceMember',
  'banWorkspaceMember',
  'unbanWorkspaceMember',
  'listWorkspaceBans',
  'createRoom',
  'updateRoom',
  'deleteRoom',
  'leaveRoom',
  'closeChat',
  'reopenChat',
  'addRoomMember',
  'removeRoomMember',
  'resolveDirectMessage',
  'createInvite',
  'resolveInvite',
  'redeemInvite',
  'createAgentPairingCode',
  'claimAgentPairing',
  'updateAgentSoul',
  'updateAgentModelSelection',
  'refreshAgentModelCatalog',
  'updateAgentYolo',
  'updateAgentAccessPolicy',
  'removeAgent',
  'updatePersonProfile',
  'updateIdentityFace',
  'updateIdentityPushLevel',
  'setRoomRepository',
  'setRoomTargetBranch',
  'setRoomGitHubEvents',
  'removeRoomRepository',
  'listRoomWorkflows',
  'dispatchRoomWorkflow',
  'approveCornerMerge',
  'getAuthCapabilities',
  'beginGitHubIdentityBind',
  'completeGitHubIdentityBind',
  'recoverGitHubIdentity',
  'getIdentityRecovery',
  'getManagedIdentity',
  'adoptGitHubHandle',
  'claimManagedHandle',
  'listGitHubRepositories',
  'beginGitHubInstallation',
  'createGitHubRepository',
  'getGitHubRepositoryAccess',
  'uploadMedia',
  'registerPushDevice',
  'unregisterPushDevice',
  'sendPushTest',
  'reportRunningUpdate',
  'readWorkbench',
  'pairConnector',
  'unpairConnector',
  'readConnectionDetail',
  'revokeConnectionGrants',
  'createWallet',
  'readWallet',
  'sendFromWallet',
  'grantWalletDelegation',
  'readWalletHistory',
  'deleteAccount',
]);

const SPECTATOR_READ_OPERATIONS = new Set<keyof PhoneOperationMap>([
  'leaveWorkspace',
  'leaveRoom',
  'closeChat',
  'reopenChat',
  'listMessageBookmarks',
  'setMessageBookmark',
  'readWorkbench',
  'readConnectionDetail',
  'readWallet',
  'readWalletHistory',
  'getGitHubRepositoryAccess',
  'listRoomWorkflows',
  'listRoomSchedules',
]);
