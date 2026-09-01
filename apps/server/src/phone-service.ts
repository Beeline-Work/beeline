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
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import type { GitHubOperations } from './github-operations.js';

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
  repository_remote: string | null;
  repository_target_branch: string;
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
        read_at: Date | null;
        working: boolean;
        needs_you: boolean;
      }
    >(
      `
      SELECT r.*,
        (SELECT count(*)::text FROM memberships rm WHERE rm.room_id=r.id AND rm.removed_at IS NULL) member_count,
        (SELECT count(*)::text FROM rooms c WHERE c.parent_id=r.id) corner_count,
        lm.id latest_id,lm.text latest_text,lm.created_at latest_created_at,lm.author_id latest_author_id,
        li.kind latest_author_kind,li.name latest_author_name, mark.message_created_at read_at,
        EXISTS(SELECT 1 FROM agent_turns t WHERE (t.room_id=r.id OR t.room_id IN (SELECT id FROM rooms WHERE parent_id=r.id)) AND t.status='working') working,
        EXISTS(SELECT 1 FROM permission_authority p WHERE (p.room_id=r.id OR p.room_id IN (SELECT id FROM rooms WHERE parent_id=r.id)) AND p.status='pending') needs_you
      FROM rooms r
      JOIN memberships member ON member.room_id=r.id AND member.identity_id=$2 AND member.removed_at IS NULL
      LEFT JOIN LATERAL (SELECT * FROM messages WHERE room_id=r.id AND presentation='message' ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN room_read_marks mark ON mark.room_id=r.id AND mark.identity_id=$2
      WHERE r.workspace_id=$1 AND r.parent_id IS NULL
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
        unread: Boolean(
          row.latest_created_at && (!row.read_at || row.latest_created_at > row.read_at),
        ),
        ...(row.repository_key ? { repositoryName: row.repository_key.split('/').at(-1) } : {}),
        ...(row.needs_you
          ? { agentState: 'needs-you' as const }
          : row.working
            ? { agentState: 'working' as const }
            : {}),
      })),
      viewer: await this.requireIdentity(viewerId),
      truncated: rooms.rows.length > 200,
      watchFilters: [],
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
    const messages = await this.messageRows(roomId, undefined, 30);
    const members = await this.members(room.workspace_id, roomId);
    const viewerIdentity = await this.requireIdentity(viewerId);
    const turns = await this.database.query<{
      request_id: string;
      agent_id: string;
      status: 'working' | 'complete' | 'failed';
      created_at: Date;
      generation_id: string | null;
    }>(`SELECT * FROM agent_turns WHERE room_id=$1 ORDER BY created_at DESC`, [roomId]);
    const corners = await this.readCorners(roomId, viewerId);
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
      ? (
          await this.database.query<
            MessageRow & {
              author_kind: 'human' | 'agent';
              author_name: string;
              author_handle: string | null;
              author_avatar: string | null;
            }
          >(
            `SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,i.avatar author_avatar
             FROM messages m JOIN identities i ON i.id=m.author_id
             WHERE m.room_id=$1 AND m.created_at<=$2
             ORDER BY m.created_at DESC,m.id ASC LIMIT 10`,
            [room.parent_id, room.created_at],
          )
        ).rows
          .reverse()
          .map((row) => projectedMessage(row, this.publicOrigin))
      : [];
    return {
      room:
        room.parent_id && !paintedRoom.about && facts?.objective
          ? { ...paintedRoom, about: facts.objective }
          : paintedRoom,
      messages: messages.reverse().map((row) => projectedMessage(row, this.publicOrigin)),
      members,
      latestAgentTurns: turns.rows.map((turn) => ({
        requestId: turn.request_id,
        agentPubkey: turn.agent_id,
        status: turn.status,
        createdAt: unix(turn.created_at),
        ...(turn.generation_id ? { generationId: turn.generation_id } : {}),
      })),
      viewer: {
        identity: viewerIdentity,
        role: room.viewer_role,
        permissions: { send: !room.archived_at, manage: room.viewer_role !== 'member' },
      },
      ...(room.direct_participants?.length === 2
        ? { directMessage: { participants: room.direct_participants as [string, string] } }
        : {}),
      ...(parent ? { parent: roomHeader(parent, this.publicOrigin) } : {}),
      briefing,
      ...(room.parent_id && plan ? { cornerPlan: plan } : {}),
      ...(room.repository_key && room.repository_remote
        ? {
            repository: {
              key: room.repository_key,
              name: room.repository_key.split('/').at(-1) ?? room.repository_key,
              remote: room.repository_remote,
              targetBranch: room.repository_target_branch,
              updatedAt: unix(room.updated_at),
              ...(room.github_installation_id
                ? { githubInstallationId: Number(room.github_installation_id) }
                : {}),
              githubEventsEnabled: room.github_events_enabled,
            },
          }
        : {}),
      repositoryResolution: room.repository_key ? 'repository' : 'none',
      ...(room.parent_id ? { cornerLifecycle: await this.cornerLifecycle(room.id) } : {}),
      corners: corners?.corners.map(({ latestMessage: _latestMessage, ...corner }) => corner) ?? [],
      watchFilters: [],
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

  async readCorners(roomId: string, viewerId: string): Promise<CornerListView | null> {
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
      LEFT JOIN LATERAL (SELECT * FROM messages WHERE room_id=c.id AND presentation='message' ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN LATERAL (
        SELECT i.id identity_id,i.name,i.handle,i.avatar FROM identities i
        WHERE i.id=c.created_by AND i.kind='agent' LIMIT 1
      ) agent ON true
      LEFT JOIN LATERAL (
        SELECT status,created_at FROM agent_turns WHERE room_id=c.id
        ORDER BY created_at DESC LIMIT 1
      ) turn ON true
      WHERE c.parent_id=$1 AND EXISTS(
        SELECT 1 FROM memberships viewer
        WHERE viewer.room_id=c.id AND viewer.identity_id=$2 AND viewer.removed_at IS NULL
      ) ORDER BY c.created_at DESC,c.id DESC`,
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
    const result = await this.database.query<{
      name: string;
      avatar: string | null;
      expires_at: Date;
    }>(
      `SELECT w.name,w.avatar,i.expires_at FROM invites i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1 AND i.expires_at>now()`,
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
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,NULL,$2,'member') ON CONFLICT DO NOTHING`,
        [pairing.workspace_id, agentId],
      );
      const rooms = await database.query<{ room_id: string }>(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        SELECT m.workspace_id,m.room_id,$2,'member' FROM memberships m JOIN rooms r ON r.id=m.room_id
        WHERE m.workspace_id=$1 AND m.identity_id=$3 AND m.removed_at IS NULL AND r.parent_id IS NULL AND r.archived_at IS NULL
        ON CONFLICT DO NOTHING RETURNING room_id`,
        [pairing.workspace_id, agentId, pairing.created_by],
      );
      return {
        workspaceId: pairing.workspace_id,
        pairedBy: pairing.created_by,
        joined,
        attachedRoomIds: rooms.rows.map((row) => row.room_id),
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
      case 'createRoom':
        return (await this.createRoom(input as Input<'createRoom'>, viewerId)) as Output<Name>;
      case 'updateRoom':
        await this.updateRoom(input as Input<'updateRoom'>, viewerId);
        return undefined as Output<Name>;
      case 'deleteRoom':
        await this.archiveRoom((input as Input<'deleteRoom'>).roomId, viewerId);
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
        return (await this.managedIdentity(viewerId)) as Output<Name>;
      case 'claimManagedHandle':
        await this.database.query(`UPDATE identities SET handle=$2,updated_at=now() WHERE id=$1`, [
          viewerId,
          (input as Input<'claimManagedHandle'>).handle,
        ]);
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
    const id = messageId();
    await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,attachments,mention_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        id,
        input.roomId,
        author,
        input.text,
        JSON.stringify(input.attachments ?? []),
        JSON.stringify(input.mentions ?? []),
      ],
    );
    return { messageId: id };
  }
  private async sendReply(input: Input<'sendRoomReply'>, author: string) {
    const parent = await this.database.query<{ root_message_id: string | null }>(
      `SELECT root_message_id FROM messages WHERE id=$1 AND room_id=$2`,
      [input.parentMessageId, input.roomId],
    );
    if (!parent.rows[0] || !(await this.hasRoomAccess(input.roomId, author)))
      throw new Error('reply parent is not in this room');
    const id = messageId();
    await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,attachments,mention_ids,reply_to_message_id,root_message_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [
        id,
        input.roomId,
        author,
        input.text,
        JSON.stringify(input.attachments ?? []),
        JSON.stringify(input.mentions ?? []),
        input.parentMessageId,
        parent.rows[0].root_message_id ?? input.parentMessageId,
      ],
    );
    return { messageId: id };
  }
  private async decidePermission(input: Input<'decideWritePermission'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    const status = input.decision === 'allow' ? 'authorized' : 'denied';
    await this.database.query(
      `UPDATE permission_authority SET status=$2,updated_at=now() WHERE permission_id=$1 AND room_id=$3`,
      [input.permissionId, status, input.roomId],
    );
    const id = messageId();
    const decider = await this.requireIdentity(viewerId);
    const agent = await this.requireIdentity(input.agentId);
    await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES ($1,$2,$3,'','card','permission',$4::jsonb)`,
      [
        id,
        input.roomId,
        viewerId,
        JSON.stringify({
          permissionId: input.permissionId,
          requestId: input.requestId,
          agent,
          requester: decider,
          decider,
          tool: 'edit files',
          repository: input.repository,
          status: input.decision === 'allow' ? 'allowed' : 'denied',
        }),
      ],
    );
    return { messageId: id };
  }
  private async createWorkspace(input: Input<'createWorkspace'>, viewerId: string) {
    const id = input.workspaceId ?? randomUUID();
    await this.database.transaction(async (db) => {
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,$2)`, [id, input.name]);
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
    await this.database.query(
      `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
      [input.workspaceId, viewerId],
    );
  }
  private async createRoom(input: Input<'createRoom'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    const id = randomUUID();
    await this.database.transaction(async (db) => {
      await db.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name,visibility) VALUES($1,$2,$3,$4,$5)`,
        [id, input.workspaceId, viewerId, input.name, input.visibility ?? 'invite-only'],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT workspace_id,$1,identity_id,role FROM memberships WHERE workspace_id=$2 AND room_id IS NULL AND removed_at IS NULL`,
        [id, input.workspaceId],
      );
    });
    return { id };
  }
  private async updateRoom(input: Input<'updateRoom'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    await this.database.query(
      `UPDATE rooms SET name=COALESCE($2,name),visibility=COALESCE($3,visibility),updated_at=now() WHERE id=$1`,
      [input.roomId, input.name ?? null, input.visibility ?? null],
    );
  }
  private async archiveRoom(roomId: string, viewerId: string) {
    await this.requireManager(roomId, viewerId);
    await this.database.query(`UPDATE rooms SET archived_at=now(),updated_at=now() WHERE id=$1`, [
      roomId,
    ]);
  }
  private async leaveRoom(roomId: string, viewerId: string) {
    await this.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [roomId, viewerId],
    );
  }
  private async addRoomMember(input: Input<'addRoomMember'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    const room = (
      await this.database.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM rooms WHERE id=$1`,
        [input.roomId],
      )
    ).rows[0]!;
    const result = await this.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
      [room.workspace_id, input.roomId, input.memberId],
    );
    return { joined: result.rowCount > 0 };
  }
  private async removeRoomMember(input: Input<'removeRoomMember'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    await this.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [input.roomId, input.memberId],
    );
  }
  private async resolveDirectMessage(input: Input<'resolveDirectMessage'>, viewerId: string) {
    const participants = [viewerId, input.participantId].sort();
    const found = await this.database.query<{ id: string }>(
      `SELECT id FROM rooms WHERE workspace_id=$1 AND direct_participants=$2::jsonb`,
      [input.workspaceId, JSON.stringify(participants)],
    );
    if (found.rows[0]) return { id: found.rows[0].id, created: false };
    const id = randomUUID();
    await this.database.transaction(async (db) => {
      await db.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants) VALUES($1,$2,$3,'Direct message',$4::jsonb)`,
        [id, input.workspaceId, viewerId, JSON.stringify(participants)],
      );
      for (const member of participants)
        await db.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
          [input.workspaceId, id, member],
        );
    });
    return { id, created: true };
  }
  private async createInvite(input: Input<'createInvite'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    const value = token('bzi');
    const expiresAt = Date.now() + 7 * 86400_000;
    await this.database.query(
      `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at) VALUES($1,$2,$3,$4)`,
      [hash(value), input.workspaceId, viewerId, new Date(expiresAt)],
    );
    return { token: value, expiresAt };
  }
  private async redeemInvite(input: Input<'redeemInvite'>, viewerId: string) {
    const result = await this.database.query<{ workspace_id: string }>(
      `UPDATE invites SET consumed_at=now() WHERE token_hash=$1 AND expires_at>now() AND consumed_at IS NULL RETURNING workspace_id`,
      [hash(input.token)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('invite not found');
    const joined = await this.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member') ON CONFLICT DO NOTHING`,
      [row.workspace_id, viewerId],
    );
    return { joined: joined.rowCount > 0 };
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
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
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
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    await this.database.query(
      `UPDATE agents SET selected_model=$2,selected_effort=$3,updated_at=now() WHERE agent_id=$1`,
      [input.agentId, input.model ?? null, input.effort ?? null],
    );
  }
  private async removeAgent(input: Input<'removeAgent'>, viewerId: string) {
    await this.requireWorkspaceManager(input.workspaceId, viewerId);
    await this.database.query(
      `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
      [input.workspaceId, input.agentId],
    );
    await this.database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [
      input.agentId,
    ]);
  }
  private async updateProfile(input: Input<'updatePersonProfile'>, viewerId: string) {
    await this.database.query(
      `UPDATE identities SET name=$2,handle=COALESCE($3,handle),avatar=COALESCE($4,avatar),updated_at=now() WHERE id=$1`,
      [viewerId, input.name, input.handle ?? null, input.avatar ?? null],
    );
    return { personId: viewerId, ...input };
  }
  private async setRepository(input: Input<'setRoomRepository'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    await this.database.query(
      `UPDATE rooms SET repository_key=$2,repository_remote=$3,repository_target_branch=$4,github_installation_id=$5,updated_at=now() WHERE id=$1`,
      [
        input.roomId,
        input.key,
        input.remote,
        input.targetBranch,
        input.githubInstallationId ?? null,
      ],
    );
    return { ...input, updatedAt: Math.floor(Date.now() / 1000), githubEventsEnabled: true };
  }
  private async roomRepository(roomId: string) {
    const row = (await this.database.query<RoomRow>(`SELECT * FROM rooms WHERE id=$1`, [roomId]))
      .rows[0];
    if (!row?.repository_key || !row.repository_remote)
      throw new Error('room repository not configured');
    return {
      roomId,
      key: row.repository_key,
      remote: row.repository_remote,
      targetBranch: row.repository_target_branch,
      ...(row.github_installation_id
        ? { githubInstallationId: Number(row.github_installation_id) }
        : {}),
      updatedAt: unix(row.updated_at),
      githubEventsEnabled: row.github_events_enabled,
    };
  }
  private async setTargetBranch(input: Input<'setRoomTargetBranch'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    await this.database.query(
      `UPDATE rooms SET repository_target_branch=$2,updated_at=now() WHERE id=$1`,
      [input.roomId, input.targetBranch],
    );
    return this.roomRepository(input.roomId);
  }
  private async setGitHubEvents(input: Input<'setRoomGitHubEvents'>, viewerId: string) {
    await this.requireManager(input.roomId, viewerId);
    await this.database.query(
      `UPDATE rooms SET github_events_enabled=$2,updated_at=now() WHERE id=$1`,
      [input.roomId, input.enabled],
    );
    return this.roomRepository(input.roomId);
  }
  private async managedIdentity(viewerId: string) {
    const id = await this.requireIdentity(viewerId);
    return { personId: id.pubkey, name: id.name, ...(id.handle ? { handle: id.handle } : {}) };
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
    const rows = await this.database.query<{
      repository_id: string;
      full_name: string;
      installation_id: string;
      default_branch: string;
    }>(
      `SELECT r.* FROM github_repositories r JOIN github_installations i USING(installation_id) WHERE i.owner_id=$1 AND r.active`,
      [viewerId],
    );
    return {
      installed: rows.rows.length > 0,
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
      `SELECT i.id,i.kind,i.name,i.handle,i.avatar,m.role,lo.body presence_body,lo.updated_at presence_updated_at FROM memberships m JOIN identities i ON i.id=m.identity_id LEFT JOIN LATERAL(SELECT body,updated_at FROM live_outputs WHERE agent_id=i.id AND kind='presence' ${roomId ? 'AND room_id=$2' : ''} ORDER BY updated_at DESC LIMIT 1)lo ON true WHERE m.workspace_id=$1 AND ${roomId ? 'm.room_id=$2' : 'm.room_id IS NULL'} AND m.removed_at IS NULL AND i.hidden_from_roster=false ORDER BY i.name,i.id`,
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
        `SELECT m.*,i.kind author_kind,i.name author_name,i.handle author_handle,i.avatar author_avatar FROM messages m JOIN identities i ON i.id=m.author_id WHERE m.room_id=$1 ${before ? 'AND (m.created_at,m.id)<(to_timestamp($2),$3)' : ''} ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit}`,
        before ? [roomId, before.createdAt, before.id] : [roomId],
      )
    ).rows;
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
