import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentDetailView,
  AgentPairingClaimView,
  ChatListView,
  CornerListView,
  InviteView,
  RoomHistoryView,
  RoomView,
  RoomViewIdentity,
  RoomViewMember,
  RoomViewMessage,
  WorkspaceListView,
  WorkspaceView,
} from '@beeline/api-contract/phone';
import {
  createCommunityInviteToken,
  isCommunityInviteToken,
  type PhoneOperationMap,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import type { GitHubOperations } from './github-operations.js';
import { collapsePermissionCards } from '@beeline/push-gateway/projection';
import { joinRooms } from './membership-join.js';

const DURABLE_KINDS = [0, 9, 9000, 9001, 9002, 9007, 9008, 30078, 39000, 39001, 39002];

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
  created_at: Date;
  updated_at: Date;
}
interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  text: string;
  presentation: RoomViewMessage['presentation'];
  attachments: unknown[];
  mention_ids: string[];
  reply_to_message_id: string | null;
  root_message_id: string | null;
  request_id: string | null;
  turn_id: string | null;
  activity: unknown[] | null;
  durable_fact: RoomViewMessage['durableFact'] | null;
  card_type: string | null;
  card: Record<string, unknown> | null;
  created_at: Date;
  author_kind: 'human' | 'agent';
  author_name: string;
  author_handle: string | null;
  author_avatar: string | null;
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
  };
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
    archived: Boolean(row.archived_at),
    createdAt: unix(row.created_at),
    updatedAt: unix(row.updated_at),
  };
}

function projectedMessage(row: MessageRow, publicOrigin: string): RoomViewMessage {
  const author = identity(
    {
      id: row.author_id,
      kind: row.author_kind,
      name: row.author_name,
      handle: row.author_handle,
      avatar: row.author_avatar,
    },
    publicOrigin,
  );
  const base: RoomViewMessage = {
    id: row.id,
    text: row.text,
    createdAt: unix(row.created_at),
    author,
    presentation: row.presentation,
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
    ...(row.attachments.length
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
    ...(row.mention_ids.length ? { mentionPubkeys: row.mention_ids } : {}),
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
  };
  if (!row.card_type || !row.card) return base;
  switch (row.card_type) {
    case 'permission':
      return { ...base, permission: row.card as NonNullable<RoomViewMessage['permission']> };
    case 'target-branch':
      return { ...base, targetBranch: row.card as NonNullable<RoomViewMessage['targetBranch']> };
    case 'github-event':
      return { ...base, githubEvent: row.card as NonNullable<RoomViewMessage['githubEvent']> };
    case 'daemon-fact':
      return { ...base, daemonFact: row.card as NonNullable<RoomViewMessage['daemonFact']> };
    case 'corner':
      return { ...base, corner: row.card as NonNullable<RoomViewMessage['corner']> };
    default:
      return base;
  }
}

function directMessageRoomId(workspaceId: string, participants: readonly [string, string]): string {
  const bytes = createHash('sha256')
    .update(`buzz-dm:v1:${workspaceId}:${participants.join(':')}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class PhoneService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly publicOrigin: string,
    private readonly github?: GitHubOperations,
    private readonly sendPushTest?: (identityId: string) => Promise<void>,
  ) {}

  canReadRoom(roomId: string, identityId: string): Promise<boolean> {
    return this.hasRoomAccess(roomId, identityId);
  }

  async readWorkspaces(viewerId: string): Promise<WorkspaceListView> {
    const rows = await this.database.query<{
      id: string;
      name: string;
      avatar: string | null;
      visibility: 'public' | 'invite-only';
      role: 'owner' | 'admin' | 'member';
      updated_at: Date;
    }>(
      `SELECT w.id, w.name, w.avatar, w.visibility, m.role, w.updated_at
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.identity_id = $1 AND m.room_id IS NULL AND m.removed_at IS NULL
       ORDER BY w.updated_at DESC, w.id LIMIT 51`,
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
      role: 'owner' | 'admin' | 'member';
    }>(
      `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL
       WHERE w.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL`,
      [workspaceId, viewerId],
    );
    const row = workspace.rows[0];
    if (!row) return null;
    const members = await this.members(workspaceId, null);
    const humans = members.filter((member) => member.identity.kind === 'human');
    const agents = members.filter((member) => member.identity.kind === 'agent');
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
      managerSettings: { visibility: row.visibility },
      members: humans.slice(0, 200),
      agents: agents.slice(0, 200),
      membersTruncated: humans.length > 200,
      agentsTruncated: agents.length > 200,
      viewer: {
        identity: viewerIdentity,
        role: row.role,
        permissions: { send: true, manage: row.role !== 'member' },
      },
      watchFilters: [],
    };
  }

  async readChats(workspaceId: string, viewerId: string): Promise<ChatListView | null> {
    const workspace = await this.database.query<{
      id: string;
      name: string;
      avatar: string | null;
      visibility: 'public' | 'invite-only';
      role: 'owner' | 'admin' | 'member';
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
        corner_count: string;
        latest_id: string | null;
        latest_text: string | null;
        latest_created_at: Date | null;
        latest_author_id: string | null;
        latest_author_kind: 'human' | 'agent' | null;
        latest_author_name: string | null;
        unread: boolean;
        working: boolean;
        needs_you: boolean;
      }
    >(
      `
      SELECT r.*,
        (SELECT count(*)::text FROM memberships rm WHERE rm.room_id=r.id AND rm.removed_at IS NULL) member_count,
        (SELECT count(*)::text FROM rooms c WHERE c.parent_id=r.id) corner_count,
        lm.id latest_id,lm.text latest_text,lm.created_at latest_created_at,lm.author_id latest_author_id,
        li.kind latest_author_kind,li.name latest_author_name,
        (lm.id IS NOT NULL AND (
          mark.message_created_at IS NULL OR
          (lm.created_at,lm.id)>(mark.message_created_at,mark.message_id)
        )) unread,
        EXISTS(SELECT 1 FROM agent_turns t WHERE (t.room_id=r.id OR t.room_id IN (SELECT id FROM rooms WHERE parent_id=r.id)) AND t.status='working') working,
        EXISTS(SELECT 1 FROM permission_authority p WHERE (p.room_id=r.id OR p.room_id IN (SELECT id FROM rooms WHERE parent_id=r.id)) AND p.status='pending') needs_you
      FROM rooms r
      JOIN memberships member ON member.room_id=r.id AND member.identity_id=$2 AND member.removed_at IS NULL
      LEFT JOIN LATERAL (SELECT * FROM messages WHERE room_id=r.id AND presentation IN ('message','system') ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN room_read_marks mark ON mark.room_id=r.id AND mark.identity_id=$2
      WHERE r.workspace_id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
      ORDER BY COALESCE(lm.created_at,r.updated_at) DESC,r.id LIMIT 201`,
      [workspaceId, viewerId],
    );
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
        memberCount: Number(row.member_count),
        cornerCount: Number(row.corner_count),
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
                author: {
                  pubkey: row.latest_author_id,
                  kind: row.latest_author_kind,
                  name: row.latest_author_name,
                },
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
      })),
      viewer: await this.requireIdentity(viewerId),
      truncated: rooms.rows.length > 200,
      watchFilters: rooms.rows.length
        ? [{ kinds: [9, 9000, 9001, 9002, 9007, 9008], '#h': rooms.rows.map((row) => row.id) }]
        : [],
    };
  }

  async readRoom(roomId: string, viewerId: string): Promise<RoomView | null> {
    const roomResult = await this.database.query<
      RoomRow & { viewer_role: 'owner' | 'admin' | 'member' }
    >(
      `SELECT r.*,m.role viewer_role FROM rooms r JOIN memberships m ON m.room_id=r.id
       WHERE r.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL`,
      [roomId, viewerId],
    );
    const room = roomResult.rows[0];
    if (!room) return null;
    const members = await this.members(room.workspace_id, roomId);
    const turns = await this.database.query<{
      request_id: string;
      agent_id: string;
      status: 'working' | 'complete' | 'failed';
      created_at: Date;
      generation_id: string | null;
    }>(
      `SELECT DISTINCT ON(agent_id) request_id,agent_id,status,created_at,generation_id
       FROM agent_turns WHERE room_id=$1 ORDER BY agent_id,created_at DESC,request_id DESC`,
      [roomId],
    );
    const latestAgentTurns = turns.rows
      .map((turn) => ({
        requestId: turn.request_id,
        agentPubkey: turn.agent_id,
        status: turn.status,
        createdAt: unix(turn.created_at),
        ...(turn.generation_id ? { generationId: turn.generation_id } : {}),
      }))
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.agentPubkey.localeCompare(right.agentPubkey),
      );
    const messages = await this.roomMessages(roomId, latestAgentTurns);
    const familyRoomId = room.parent_id ?? roomId;
    const corners = await this.readCorners(familyRoomId, viewerId, true);
    const parent = room.parent_id
      ? (await this.database.query<RoomRow>(`SELECT * FROM rooms WHERE id=$1`, [room.parent_id]))
          .rows[0]
      : undefined;
    const facts = (
      await this.database.query<{
        plan: RoomView['cornerPlan'] | null;
        objective: string;
      }>(`SELECT plan,objective FROM corner_facts WHERE corner_id=$1`, [roomId])
    ).rows[0];
    const plan = facts?.plan;
    const paintedRoom = roomHeader(room, this.publicOrigin);
    const briefing = room.parent_id
      ? collapsePermissionCards(
          (
            await this.database.query<
              MessageRow & {
                author_kind: 'human' | 'agent';
                author_name: string;
                author_handle: string | null;
                author_avatar: string | null;
              }
            >(
              `SELECT m.*,
               COALESCE(m.legacy_event->>'authorKind',i.kind) author_kind,
               COALESCE(m.legacy_event->>'authorName',i.name) author_name,
               CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorHandle' ELSE i.handle END author_handle,
               CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorAvatar' ELSE i.avatar END author_avatar
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
             ORDER BY m.created_at DESC,m.id ASC LIMIT 10`,
              [room.parent_id, room.created_at],
            )
          ).rows
            .map((row) => projectedMessage(row, this.publicOrigin))
            .sort(
              (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
            ),
        )
      : [];
    return {
      room:
        room.parent_id && !paintedRoom.about && facts?.objective
          ? { ...paintedRoom, about: facts.objective }
          : paintedRoom,
      messages,
      members,
      latestAgentTurns,
      viewer: {
        identity: members.find((member) => member.identity.pubkey === viewerId)?.identity ?? {
          pubkey: viewerId,
          kind: 'human',
          name: `Person ${viewerId.slice(0, 8)}`,
        },
        role: room.viewer_role,
        permissions: { send: !room.archived_at, manage: room.viewer_role !== 'member' },
      },
      ...(room.direct_participants?.length === 2
        ? { directMessage: { participants: room.direct_participants as [string, string] } }
        : {}),
      ...(parent ? { parent: roomHeader(parent, this.publicOrigin) } : {}),
      briefing,
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
      ...(room.parent_id ? { cornerLifecycle: await this.cornerLifecycle(room.id) } : {}),
      corners: corners?.corners.map(({ latestMessage: _latestMessage, ...corner }) => corner) ?? [],
      watchFilters: roomFilters(
        roomId,
        room.workspace_id,
        [
          ...(room.parent_id ? [room.parent_id] : []),
          ...(corners?.corners.map((item) => item.corner.id) ?? []),
        ],
        members,
      ),
    };
  }

  async readHistory(
    roomId: string,
    viewerId: string,
    before?: { createdAt: number; id: string },
  ): Promise<RoomHistoryView | null> {
    if (!(await this.hasRoomAccess(roomId, viewerId))) return null;
    const rows = await this.messageRows(roomId, before, 31);
    const page = rows.slice(0, 30);
    const tail = page.at(-1);
    return {
      roomId,
      messages: page.reverse().map((row) => projectedMessage(row, this.publicOrigin)),
      ...(rows.length > 30 && tail
        ? { nextBefore: { createdAt: unix(tail.created_at), id: tail.id } }
        : {}),
    };
  }

  async readCorners(
    roomId: string,
    viewerId: string,
    roomViewFamilyOrder = false,
  ): Promise<CornerListView | null> {
    const parent = await this.database.query<
      RoomRow & { viewer_role: 'owner' | 'admin' | 'member' }
    >(
      `SELECT r.*,m.role viewer_role FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE r.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL`,
      [roomId, viewerId],
    );
    const room = parent.rows[0];
    if (!room) return null;
    const rows = await this.database.query<
      RoomRow & {
        lifecycle: RoomView['cornerLifecycle'] | null;
        objective: string | null;
        latest_id: string | null;
        latest_text: string | null;
        latest_created_at: Date | null;
        latest_author_id: string | null;
        latest_author_kind: 'human' | 'agent' | null;
        latest_author_name: string | null;
        agent_id: string | null;
        agent_name: string | null;
        agent_handle: string | null;
        agent_avatar: string | null;
        latest_turn_status: 'working' | 'complete' | 'failed' | null;
        latest_turn_created_at: Date | null;
      }
    >(
      `
      SELECT c.*,f.lifecycle,f.objective,lm.id latest_id,lm.text latest_text,lm.created_at latest_created_at,lm.author_id latest_author_id,
        li.kind latest_author_kind,li.name latest_author_name,agent.identity_id agent_id,
        agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
        turn.status latest_turn_status,turn.created_at latest_turn_created_at
      FROM rooms c LEFT JOIN corner_facts f ON f.corner_id=c.id
      LEFT JOIN LATERAL (SELECT * FROM messages WHERE room_id=c.id AND presentation IN ('message','system') ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN LATERAL (
        SELECT i.id identity_id,
          COALESCE(member.identity_profile->>'name',i.name) name,
          CASE WHEN member.identity_profile IS NOT NULL THEN member.identity_profile->>'handle' ELSE i.handle END handle,
          CASE WHEN member.identity_profile IS NOT NULL THEN member.identity_profile->>'avatar' ELSE i.avatar END avatar
        FROM identities i
        LEFT JOIN memberships member ON member.room_id=c.id AND member.identity_id=i.id
          AND member.removed_at IS NULL
        WHERE i.id=c.created_by
          AND COALESCE(member.identity_profile->>'kind',i.kind)='agent' LIMIT 1
      ) agent ON true
      LEFT JOIN LATERAL (
        SELECT status,created_at FROM agent_turns WHERE room_id=c.id
        ORDER BY created_at DESC LIMIT 1
      ) turn ON true
      WHERE c.parent_id=$1 AND EXISTS(
        SELECT 1 FROM memberships viewer
        WHERE viewer.room_id=c.id AND viewer.identity_id=$2 AND viewer.removed_at IS NULL
      ) ${roomViewFamilyOrder ? '' : 'ORDER BY c.created_at DESC,c.id DESC'}`,
      [roomId, viewerId],
    );
    const viewerIdentity = await this.requireIdentity(viewerId);
    return {
      room: roomHeader(room, this.publicOrigin),
      corners: rows.rows.map((corner) => {
        const lifecycle = corner.lifecycle ?? {
          lifecycle: corner.archived_at ? 'done' : 'unknown',
          checks: 'unknown',
        };
        const hasLiveWorkingTurn =
          corner.latest_turn_status === 'working' && lifecycle.lifecycle !== 'done';
        const status =
          corner.archived_at || lifecycle.lifecycle === 'done'
            ? 'closed'
            : hasLiveWorkingTurn
              ? 'working'
              : 'idle';
        return {
          corner: roomHeader(corner, this.publicOrigin),
          lifecycle,
          status,
          statusAt:
            hasLiveWorkingTurn && corner.latest_turn_created_at
              ? unix(corner.latest_turn_created_at)
              : unix(corner.updated_at),
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
      }),
      viewer: {
        identity: viewerIdentity,
        role: room.viewer_role,
        permissions: { send: !room.archived_at, manage: room.viewer_role !== 'member' },
      },
      watchFilters: [],
    };
  }

  async readAgent(
    workspaceId: string,
    agentId: string,
    viewerId: string,
  ): Promise<AgentDetailView | null> {
    const viewer = await this.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [workspaceId, viewerId],
    );
    if (!viewer.rowCount) return null;
    const member = (await this.members(workspaceId, null)).find(
      (entry) => entry.identity.pubkey === agentId,
    );
    if (!member || member.identity.kind !== 'agent') return null;
    const config = (
      await this.database.query<{
        soul: AgentDetailView['soul'] | null;
        model_catalog: AgentDetailView['catalog'];
        selected_model: string | null;
        selected_effort: string | null;
      }>(`SELECT soul,model_catalog,selected_model,selected_effort FROM agents WHERE agent_id=$1`, [
        agentId,
      ])
    ).rows[0];
    return {
      workspaceId,
      agent: member,
      ...(config?.soul ? { soul: config.soul } : {}),
      catalog: config?.model_catalog ?? [],
      ...(config?.selected_model || config?.selected_effort
        ? {
            selected: {
              ...(config.selected_model ? { model: config.selected_model } : {}),
              ...(config.selected_effort ? { effort: config.selected_effort } : {}),
            },
          }
        : {}),
      watchFilters: [],
    };
  }

  async readInvite(rawToken: string, viewerId: string): Promise<InviteView | null> {
    void viewerId;
    if (!isCommunityInviteToken(rawToken)) return null;
    const result = await this.database.query<{
      name: string;
      avatar: string | null;
      expires_at: Date;
    }>(
      `SELECT w.name,w.avatar,i.expires_at FROM invites i
       JOIN workspaces w ON w.id=i.workspace_id
       JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
         AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
       WHERE i.token_hash=$1 AND i.expires_at>now()`,
      [hash(rawToken)],
    );
    const row = result.rows[0];
    return row
      ? {
          name: row.name,
          ...(row.avatar ? { avatar: assetUrl(row.avatar, this.publicOrigin) } : {}),
          expiresAt: unix(row.expires_at),
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
      const joined = !pairing.claimed_by;
      if (joined)
        await database.query(
          `UPDATE agent_pairing_codes SET claimed_by=$2,claimed_at=now() WHERE code_hash=$1`,
          [hash(code), agentId],
        );
      const workspaceMembership = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,NULL,$2,'member') ON CONFLICT DO NOTHING`,
        [pairing.workspace_id, agentId],
      );
      const rooms = await joinRooms(database, {
        workspaceId: pairing.workspace_id,
        identityId: agentId,
        rooms: { type: 'inherited-live-top-level', identityId: pairing.created_by },
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

  async claimAgentConnectPairing(input: {
    code: string;
    agentPubkey: string;
    agentName: string;
    model: string;
    soul: string;
  }): Promise<
    | { status: 'claimed'; workspaceId: string; workspaceName: string; pairedBy: string }
    | { status: 'not_found' | 'expired' | 'already_claimed' }
  >;
  async claimAgentConnectPairing(
    input: {
      code: string;
      agentPubkey: string;
      agentName: string;
      model: string;
      soul: string;
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
        daemonExchangeToken: string;
      }
    | { status: 'not_found' | 'expired' | 'already_claimed' }
  >;
  async claimAgentConnectPairing(
    input: {
      code: string;
      agentPubkey: string;
      agentName: string;
      model: string;
      soul: string;
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

      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent',$2)`, [
        input.agentPubkey,
        input.agentName,
      ]);
      await database.query(
        `INSERT INTO agents(agent_id,owner_id,soul,selected_model)
         VALUES($1,$2,$3::jsonb,$4)`,
        [
          input.agentPubkey,
          pairing.created_by,
          JSON.stringify({ name: input.agentName, instructions: input.soul }),
          input.model,
        ],
      );
      await database.query(
        `UPDATE agent_pairing_codes SET claimed_by=$2,claimed_at=now() WHERE code_hash=$1`,
        [hash(input.code), input.agentPubkey],
      );
      const workspaceMembership = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES ($1,NULL,$2,'member')`,
        [pairing.workspace_id, input.agentPubkey],
      );
      await joinRooms(database, {
        workspaceId: pairing.workspace_id,
        identityId: input.agentPubkey,
        rooms: { type: 'inherited-live-top-level', identityId: pairing.created_by },
        workspaceJoined: workspaceMembership.rowCount > 0,
      });
      const exchange = createDaemonExchange
        ? await createDaemonExchange(input.agentPubkey, database)
        : undefined;
      return {
        status: 'claimed',
        workspaceId: pairing.workspace_id,
        workspaceName: pairing.workspace_name,
        pairedBy: pairing.created_by,
        ...(exchange ? { daemonExchangeToken: exchange.exchangeToken } : {}),
      };
    });
  }

  async execute<Name extends keyof PhoneOperationMap>(
    name: Name,
    input: Input<Name>,
    viewerId: string,
  ): Promise<Output<Name>> {
    switch (name) {
      case 'sendRoomMessage':
        return (await this.sendMessage(
          input as Input<'sendRoomMessage'>,
          viewerId,
        )) as Output<Name>;
      case 'sendRoomReply':
        return (await this.sendReply(input as Input<'sendRoomReply'>, viewerId)) as Output<Name>;
      case 'decideWritePermission':
        return (await this.decidePermission(
          input as Input<'decideWritePermission'>,
          viewerId,
        )) as Output<Name>;
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
      case 'addWorkspaceMember':
        return (await this.addWorkspaceMember(
          input as Input<'addWorkspaceMember'>,
          viewerId,
        )) as Output<Name>;
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
      case 'removeAgent':
        await this.removeAgent(input as Input<'removeAgent'>, viewerId);
        return undefined as Output<Name>;
      case 'updatePersonProfile':
        return (await this.updateProfile(
          input as Input<'updatePersonProfile'>,
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
      case 'listGitHubRepositories':
        if ((input as Input<'listGitHubRepositories'>).refresh)
          await this.requireGitHub().refresh(viewerId);
        return (await this.listRepositories(viewerId)) as Output<Name>;
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
      case 'sendPushTest':
        if (!this.sendPushTest) throw new Error('push delivery is not configured');
        await this.sendPushTest(viewerId);
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
    const message = await this.database.query<{ created_at: Date }>(
      `SELECT created_at FROM messages WHERE id=$1 AND room_id=$2`,
      [messageIdValue, roomId],
    );
    const row = message.rows[0];
    if (!row || !(await this.hasRoomAccess(roomId, viewerId))) throw new Error('message not found');
    await this.database.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT(room_id,identity_id) DO UPDATE SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id,updated_at=now()
      WHERE (EXCLUDED.message_created_at,EXCLUDED.message_id)>(room_read_marks.message_created_at,room_read_marks.message_id)`,
      [roomId, viewerId, row.created_at, messageIdValue],
    );
  }

  async uploadMedia(
    viewerId: string,
    bytes: Uint8Array,
    mimeType: string,
    name: string,
    maximumBytes: number,
  ) {
    if (!bytes.length || bytes.length > maximumBytes)
      throw new Error('media size is outside the allowed range');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const id = randomUUID();
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO media(id,owner_id,bytes,mime_type,name,sha256) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(owner_id,sha256) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [id, viewerId, Buffer.from(bytes), mimeType, name, digest],
    );
    const storedId = result.rows[0]!.id;
    return {
      url: `${this.publicOrigin}/v1/media/${storedId}`,
      name,
      mimeType,
      size: bytes.length,
      sha256: digest,
    };
  }

  private async sendMessage(input: Input<'sendRoomMessage'>, author: string) {
    if (!(await this.hasRoomAccess(input.roomId, author))) throw new Error('room access denied');
    const id = input.messageId ?? messageId();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('messageId is invalid');
    const attachments = JSON.stringify(input.attachments ?? []);
    const mentions = JSON.stringify(input.mentions ?? []);
    const values = [id, input.roomId, author, input.text, attachments, mentions];
    const inserted = await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,attachments,mention_ids)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(id) DO NOTHING`,
      values,
    );
    if (!inserted.rowCount) {
      const retry = await this.database.query(
        `SELECT 1 FROM messages
         WHERE id=$1 AND room_id=$2 AND author_id=$3 AND text=$4
           AND attachments=$5::jsonb AND mention_ids=$6::jsonb
           AND reply_to_message_id IS NULL`,
        values,
      );
      if (!retry.rowCount) throw new Error('messageId is invalid');
    }
    return { messageId: id };
  }
  private async sendReply(input: Input<'sendRoomReply'>, author: string) {
    const parent = await this.database.query<{ root_message_id: string | null }>(
      `SELECT root_message_id FROM messages WHERE id=$1 AND room_id=$2`,
      [input.parentMessageId, input.roomId],
    );
    if (!parent.rows[0] || !(await this.hasRoomAccess(input.roomId, author)))
      throw new Error('reply parent is not in this room');
    const id = input.messageId ?? messageId();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('messageId is invalid');
    const values = [
      id,
      input.roomId,
      author,
      input.text,
      JSON.stringify(input.attachments ?? []),
      JSON.stringify(input.mentions ?? []),
      input.parentMessageId,
      parent.rows[0].root_message_id ?? input.parentMessageId,
    ];
    const inserted = await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,attachments,mention_ids,reply_to_message_id,root_message_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT(id) DO NOTHING`,
      values,
    );
    if (!inserted.rowCount) {
      const retry = await this.database.query(
        `SELECT 1 FROM messages
         WHERE id=$1 AND room_id=$2 AND author_id=$3 AND text=$4
           AND attachments=$5::jsonb AND mention_ids=$6::jsonb
           AND reply_to_message_id=$7 AND root_message_id=$8`,
        values,
      );
      if (!retry.rowCount) throw new Error('messageId is invalid');
    }
    return { messageId: id };
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
    if (viewerId !== pending.principal_id) await this.requireManager(input.roomId, viewerId);
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
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES ($1,$2,$3,'','card','permission',$4::jsonb)`,
        [
          id,
          input.roomId,
          viewerId,
          JSON.stringify({
            permissionId: input.permissionId,
            requestId: input.requestId,
            agent,
            requester,
            decider,
            tool: typeof card?.tool === 'string' ? card.tool : 'edit files',
            repository: input.repository,
            ...(card?.purpose === 'squire-spending' ? { purpose: 'squire-spending' } : {}),
            status: input.decision === 'allow' ? 'allowed' : 'denied',
          }),
        ],
      );
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
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    await this.database.query(
      `UPDATE workspaces SET name=COALESCE($2,name),avatar=COALESCE($3,avatar),visibility=COALESCE($4,visibility),updated_at=now() WHERE id=$1`,
      [input.workspaceId, input.name ?? null, input.avatar ?? null, input.visibility ?? null],
    );
  }
  private async leaveWorkspace(input: Input<'leaveWorkspace'>, viewerId: string) {
    await this.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      const current = (
        await database.query<{ role: 'owner' | 'admin' | 'member' }>(
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
    });
  }
  private async createRoom(input: Input<'createRoom'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    const id = randomUUID();
    await this.database.transaction(async (db) => {
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
          input.name,
          input.visibility ?? 'invite-only',
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
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [input.workspaceId, id, viewerId],
      );
    });
    return { id };
  }
  private async updateRoom(input: Input<'updateRoom'>, viewerId: string) {
    await this.requireTopLevelRoom(input.roomId);
    await this.requireManager(input.roomId, viewerId);
    await this.database.query(
      `UPDATE rooms SET name=COALESCE($2,name),visibility=COALESCE($3,visibility),updated_at=now() WHERE id=$1`,
      [input.roomId, input.name ?? null, input.visibility ?? null],
    );
  }
  private async deleteRoom(roomId: string, viewerId: string) {
    await this.requireTopLevelRoom(roomId);
    const membership = await this.database.query(
      `SELECT 1 FROM memberships
       WHERE room_id=$1 AND identity_id=$2 AND role='owner' AND removed_at IS NULL`,
      [roomId, viewerId],
    );
    if (!membership.rowCount) throw new Error('room owner required');
    await this.database.query(`DELETE FROM rooms WHERE id=$1`, [roomId]);
  }
  private async leaveRoom(roomId: string, viewerId: string) {
    await this.requireTopLevelRoom(roomId);
    const membership = await this.database.query<{ role: 'owner' | 'admin' | 'member' }>(
      `SELECT role FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [roomId, viewerId],
    );
    const role = membership.rows[0]?.role;
    if (role !== 'member') {
      throw new Error(
        role === 'owner' || role === 'admin'
          ? 'room managers cannot leave'
          : 'room membership required',
      );
    }
    await this.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [roomId, viewerId],
    );
  }
  private async addRoomMember(input: Input<'addRoomMember'>, viewerId: string) {
    const room = await this.requireTopLevelRoom(input.roomId);
    await this.requireManager(input.roomId, viewerId);
    const workspaceMember = await this.database.query(
      `SELECT 1 FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [room.workspace_id, input.memberId],
    );
    if (!workspaceMember.rowCount) throw new Error('workspace membership required');
    const result = await joinRooms(this.database, {
      workspaceId: room.workspace_id,
      identityId: input.memberId,
      rooms: { type: 'rooms', roomIds: [input.roomId] },
    });
    return { joined: result.roomIds.length > 0 };
  }
  private async removeRoomMember(input: Input<'removeRoomMember'>, viewerId: string) {
    await this.requireTopLevelRoom(input.roomId);
    await this.requireManager(input.roomId, viewerId);
    const roles = await this.database.query<{
      identity_id: string;
      role: 'owner' | 'admin' | 'member';
    }>(
      `SELECT identity_id,role FROM memberships
       WHERE room_id=$1 AND identity_id IN ($2,$3) AND removed_at IS NULL`,
      [input.roomId, viewerId, input.memberId],
    );
    const actor = roles.rows.find((row) => row.identity_id === viewerId);
    const target = roles.rows.find((row) => row.identity_id === input.memberId);
    if (!target) throw new Error('room membership required');
    if (input.memberId === viewerId) throw new Error('room managers cannot remove themselves');
    if (target.role === 'owner' || (actor?.role === 'admin' && target.role === 'admin')) {
      throw new Error('room manager cannot remove a member with equal or greater authority');
    }
    await this.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [input.roomId, input.memberId],
    );
  }
  private async addWorkspaceMember(input: Input<'addWorkspaceMember'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    if (input.memberId === viewerId) throw new Error('workspace managers cannot change themselves');
    await this.requireIdentity(input.memberId);
    return this.database.transaction(async (database) => {
      await database.query(`SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, [input.workspaceId]);
      const roles = await database.query<{
        identity_id: string;
        role: 'owner' | 'admin' | 'member';
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
        actor.role === 'admin' &&
        (input.role === 'owner' || target?.role === 'owner' || target?.role === 'admin')
      ) {
        throw new Error('workspace manager cannot change a member with equal or greater authority');
      }
      if (target) {
        await database.query(
          `UPDATE memberships SET role=$3,removed_at=NULL
           WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
          [input.workspaceId, input.memberId, input.role],
        );
        if (target.removed_at)
          await joinRooms(database, {
            workspaceId: input.workspaceId,
            identityId: input.memberId,
            rooms: { type: 'none' },
            workspaceJoined: true,
          });
        return { joined: target.removed_at !== null };
      }
      const inserted = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,$3) ON CONFLICT DO NOTHING`,
        [input.workspaceId, input.memberId, input.role],
      );
      if (inserted.rowCount)
        await joinRooms(database, {
          workspaceId: input.workspaceId,
          identityId: input.memberId,
          rooms: { type: 'none' },
          workspaceJoined: true,
        });
      return { joined: inserted.rowCount > 0 };
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
    if (found.rows[0]) return { id: found.rows[0].id, created: false };
    const id = directMessageRoomId(input.workspaceId, participants as [string, string]);
    const created = await this.database.transaction(async (db) => {
      const inserted = await db.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants)
         VALUES($1,$2,$3,'Direct message',$4::jsonb) ON CONFLICT DO NOTHING`,
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
    const result = await this.database.query<{ workspace_id: string }>(
      `SELECT i.workspace_id FROM invites i
       JOIN memberships creator ON creator.workspace_id=i.workspace_id AND creator.room_id IS NULL
         AND creator.identity_id=i.created_by AND creator.removed_at IS NULL
       WHERE i.token_hash=$1 AND i.expires_at>now()`,
      [hash(input.token)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('invite not found');
    return this.database.transaction(async (database) => {
      const joined = await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')
         ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL
         DO UPDATE SET role='member',removed_at=NULL WHERE memberships.removed_at IS NOT NULL`,
        [row.workspace_id, viewerId],
      );
      await joinRooms(database, {
        workspaceId: row.workspace_id,
        identityId: viewerId,
        rooms: { type: 'all-live-top-level' },
        workspaceJoined: joined.rowCount > 0,
      });
      return { joined: joined.rowCount > 0, workspaceId: row.workspace_id };
    });
  }
  private async createPairing(input: Input<'createAgentPairingCode'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    const code = `BUZZ-${randomBytes(4).toString('hex').toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
    const expiresAt = Date.now() + 15 * 60_000;
    await this.database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at) VALUES($1,$2,$3,$4)`,
      [hash(code), input.workspaceId, viewerId, new Date(expiresAt)],
    );
    return { code, expiresAt };
  }
  private async updateAgentSoul(input: Input<'updateAgentSoul'>, viewerId: string) {
    await this.requireWorkspaceAgent(input.workspaceId, input.agentId, viewerId);
    await this.database.query(
      `UPDATE agents SET soul=$2::jsonb,updated_at=now() WHERE agent_id=$1`,
      [
        input.agentId,
        JSON.stringify({
          name: input.name,
          instructions: input.instructions,
          avatarSeed: input.avatarSeed,
          ...(input.avatar ? { avatar: input.avatar } : {}),
        }),
      ],
    );
    await this.database.query(
      `UPDATE identities SET name=$2,avatar=COALESCE($3,avatar),updated_at=now() WHERE id=$1`,
      [input.agentId, input.name, input.avatar ?? null],
    );
  }
  private async updateAgentModel(input: Input<'updateAgentModelSelection'>, viewerId: string) {
    await this.requireWorkspaceAgent(input.workspaceId, input.agentId, viewerId);
    const hasModel = Object.prototype.hasOwnProperty.call(input, 'model');
    const hasEffort = Object.prototype.hasOwnProperty.call(input, 'effort');
    await this.database.query(
      `UPDATE agents
       SET selected_model=CASE WHEN $2 THEN $3 ELSE selected_model END,
           selected_effort=CASE WHEN $4 THEN $5 ELSE selected_effort END,
           updated_at=now()
       WHERE agent_id=$1`,
      [input.agentId, hasModel, input.model ?? null, hasEffort, input.effort ?? null],
    );
  }
  private async removeAgent(input: Input<'removeAgent'>, viewerId: string) {
    await this.requireWorkspaceAgent(input.workspaceId, input.agentId, viewerId);
    await this.database.query(
      `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
      [input.workspaceId, input.agentId],
    );
    await this.database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [
      input.agentId,
    ]);
  }
  private async updateProfile(input: Input<'updatePersonProfile'>, viewerId: string) {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 60))
      throw new Error('invalid person name');
    if (
      input.handle !== undefined &&
      !/^[a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?$/.test(input.handle)
    )
      throw new Error('invalid person handle');
    const updated = await this.database.query<IdentityRow>(
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
  }
  private async setRepository(input: Input<'setRoomRepository'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
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
    await this.requireManager(input.roomId, viewerId);
    const updated = await this.database.query(
      `UPDATE rooms SET repository_target_branch=$2,repository_updated_at=now(),updated_at=now() WHERE id=$1 AND repository_key IS NOT NULL AND repository_remote IS NOT NULL`,
      [input.roomId, input.targetBranch],
    );
    if (!updated.rowCount) throw new Error('room repository not configured');
    return this.roomRepository(input.roomId);
  }
  private async setGitHubEvents(input: Input<'setRoomGitHubEvents'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    const updated = await this.database.query(
      `UPDATE rooms SET github_events_enabled=$2,repository_updated_at=now(),updated_at=now() WHERE id=$1 AND repository_key IS NOT NULL AND repository_remote IS NOT NULL`,
      [input.roomId, input.enabled],
    );
    if (!updated.rowCount) throw new Error('room repository not configured');
    return this.roomRepository(input.roomId);
  }
  private async managedIdentity(viewerId: string) {
    const id = await this.requireIdentity(viewerId);
    return {
      personId: id.pubkey,
      name: id.name,
      ...(id.handle ? { handle: id.handle } : {}),
      ...(id.avatar ? { avatar: id.avatar } : {}),
    };
  }
  private async claimManagedHandle(viewerId: string, handle: string) {
    const claimed = await this.database.query(
      `UPDATE identities AS identity SET handle=$2,updated_at=now()
       WHERE identity.id=$1 AND NOT EXISTS(
         SELECT 1 FROM identities AS other
         WHERE other.id<>$1 AND lower(other.handle)=lower($2)
       )`,
      [viewerId, handle],
    );
    if (claimed.rowCount === 0) throw new Error('managed handle is already claimed');
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
    await this.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,$3,$4) ON CONFLICT(token) DO UPDATE SET identity_id=EXCLUDED.identity_id,platform=EXCLUDED.platform,environment=EXCLUDED.environment,updated_at=now()`,
      [input.token, viewerId, input.platform, input.environment],
    );
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
  private async requireIdentity(id: string) {
    const row = (
      await this.database.query<IdentityRow>(
        `SELECT id,kind,name,handle,avatar FROM identities WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('identity not found');
    return identity(row, this.publicOrigin);
  }
  private async requireWorkspaceAgent(workspaceId: string, agentId: string, viewerId: string) {
    await this.requireWorkspaceManager(workspaceId, viewerId);
    const result = await this.database.query(
      `SELECT 1
       FROM agents a
       JOIN memberships m ON m.identity_id=a.agent_id
       WHERE a.agent_id=$1 AND m.workspace_id=$2 AND m.room_id IS NULL AND m.removed_at IS NULL`,
      [agentId, workspaceId],
    );
    if (!result.rowCount) throw new Error('agent not found in workspace');
  }
  private async hasRoomAccess(roomId: string, identityId: string) {
    return (
      (
        await this.database.query(
          `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
          [roomId, identityId],
        )
      ).rowCount > 0
    );
  }
  private async requireManager(roomId: string, identityId: string) {
    const row = await this.database.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND role IN ('owner','admin') AND removed_at IS NULL`,
      [roomId, identityId],
    );
    if (!row.rowCount) throw new Error('room manager required');
  }
  private async requireTopLevelRoom(roomId: string) {
    const room = (
      await this.database.query<{
        workspace_id: string;
        parent_id: string | null;
        direct_participants: string[] | null;
        archived_at: Date | null;
      }>(`SELECT workspace_id,parent_id,direct_participants,archived_at FROM rooms WHERE id=$1`, [
        roomId,
      ])
    ).rows[0];
    if (!room) throw new Error('room not found');
    if (room.parent_id) throw new Error('room lifecycle cannot target a corner');
    if (room.direct_participants) throw new Error('direct-message membership is immutable');
    if (room.archived_at) throw new Error('room is archived');
    return room;
  }
  private async requireWorkspaceManager(workspaceId: string, identityId: string) {
    const row = await this.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND role IN ('owner','admin') AND removed_at IS NULL`,
      [workspaceId, identityId],
    );
    if (!row.rowCount) throw new Error('workspace manager required');
  }
  private async members(workspaceId: string, roomId: string | null): Promise<RoomViewMember[]> {
    const rows = await this.database.query<
      IdentityRow & {
        role: 'owner' | 'admin' | 'member';
        presence_body: { status: 'online' | 'offline'; observedAt: number } | null;
        presence_updated_at: Date | null;
      }
    >(
      `SELECT i.id,
         COALESCE(m.identity_profile->>'kind',i.kind) kind,
         COALESCE(m.identity_profile->>'name',i.name) name,
         CASE WHEN m.identity_profile IS NOT NULL THEN m.identity_profile->>'handle' ELSE i.handle END handle,
         CASE WHEN m.identity_profile IS NOT NULL THEN m.identity_profile->>'avatar' ELSE i.avatar END avatar,
         m.role,lo.body presence_body,lo.updated_at presence_updated_at
       FROM memberships m JOIN identities i ON i.id=m.identity_id
       LEFT JOIN LATERAL(SELECT body,updated_at FROM live_outputs WHERE agent_id=i.id AND kind='presence' ${roomId ? 'AND room_id=$2' : ''} ORDER BY updated_at DESC LIMIT 1)lo ON true
       WHERE m.workspace_id=$1 AND ${roomId ? 'm.room_id=$2' : 'm.room_id IS NULL'}
         AND m.removed_at IS NULL AND i.hidden_from_roster=false`,
      roomId ? [workspaceId, roomId] : [workspaceId],
    );
    return rows.rows.map((row) => ({
      identity: identity(row, this.publicOrigin),
      role: row.role,
      ...(row.presence_body && row.presence_updated_at
        ? {
            presence: {
              status: row.presence_body.status,
              observedAt: row.presence_body.observedAt,
              ...(roomId ? { roomId } : {}),
            },
          }
        : {}),
    }));
  }
  private async messageRows(
    roomId: string,
    before: { createdAt: number; id: string } | undefined,
    limit: number,
  ) {
    return (
      await this.database.query<MessageRow>(
        `SELECT m.*,
           COALESCE(m.legacy_event->>'authorKind',i.kind) author_kind,
           COALESCE(m.legacy_event->>'authorName',i.name) author_name,
           CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorHandle' ELSE i.handle END author_handle,
           CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorAvatar' ELSE i.avatar END author_avatar
         FROM messages m JOIN identities i ON i.id=m.author_id
         WHERE m.room_id=$1 AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
         ${before ? 'AND (m.created_at,m.id)<(to_timestamp($2),$3)' : ''}
         ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit}`,
        before ? [roomId, before.createdAt, before.id] : [roomId],
      )
    ).rows;
  }
  private async roomMessages(
    roomId: string,
    latestAgentTurns: RoomView['latestAgentTurns'],
  ): Promise<RoomViewMessage[]> {
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
    const transcriptRows = await this.database.query<MessageRow>(
      `SELECT m.*,
         COALESCE(m.legacy_event->>'authorKind',i.kind) author_kind,
         COALESCE(m.legacy_event->>'authorName',i.name) author_name,
         CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorHandle' ELSE i.handle END author_handle,
         CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorAvatar' ELSE i.avatar END author_avatar
       FROM messages m JOIN identities i ON i.id=m.author_id
       WHERE m.room_id=$1 AND (m.presentation<>'activity' OR m.durable_fact IS NOT NULL)
         AND (NOT EXISTS(SELECT 1 FROM legacy_room_events any_legacy WHERE any_legacy.room_id=$1) OR ${eligible})
       ORDER BY m.created_at DESC,m.id DESC LIMIT 30`,
      [roomId],
    );
    const transcript = transcriptRows.rows.map((row) => projectedMessage(row, this.publicOrigin));
    const workingByAgent = new Map(
      latestAgentTurns
        .filter((turn) => turn.status === 'working')
        .map((turn) => [turn.agentPubkey, turn.createdAt]),
    );
    const liveRows = await this.database.query<MessageRow>(
      `SELECT m.*,
         COALESCE(m.legacy_event->>'authorKind',i.kind) author_kind,
         COALESCE(m.legacy_event->>'authorName',i.name) author_name,
         CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorHandle' ELSE i.handle END author_handle,
         CASE WHEN m.legacy_event IS NOT NULL THEN m.legacy_event->>'authorAvatar' ELSE i.avatar END author_avatar
       FROM messages m JOIN identities i ON i.id=m.author_id
       WHERE m.room_id=$1 AND m.presentation='activity' AND m.durable_fact IS NULL
         AND (NOT EXISTS(SELECT 1 FROM legacy_room_events any_legacy WHERE any_legacy.room_id=$1) OR ${eligible})
       ORDER BY m.created_at DESC,m.id DESC`,
      [roomId],
    );
    const liveActivity = liveRows.rows
      .map((row) => projectedMessage(row, this.publicOrigin))
      .filter(
        (message) =>
          message.createdAt >=
          (workingByAgent.get(message.author.pubkey) ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, 30);
    const byId = new Map(
      collapsePermissionCards([...transcript.reverse(), ...liveActivity.reverse()]).map(
        (message) => [message.id, message],
      ),
    );
    return [...byId.values()].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
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

export const PHONE_OPERATION_NAMES = new Set<keyof PhoneOperationMap>([
  'sendRoomMessage',
  'sendRoomReply',
  'decideWritePermission',
  'createWorkspace',
  'updateWorkspace',
  'leaveWorkspace',
  'addWorkspaceMember',
  'createRoom',
  'updateRoom',
  'deleteRoom',
  'leaveRoom',
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
  'removeAgent',
  'updatePersonProfile',
  'setRoomRepository',
  'setRoomTargetBranch',
  'setRoomGitHubEvents',
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
]);
