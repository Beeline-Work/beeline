import { type PhoneIdentityRow as IdentityRow } from '../phone-identity.js';
import { type AgentUsageRow } from '../agent-usage.js';
import { type CornerBriefRow } from '../corner-brief.js';
import type { AgentGrantView, AgentDetailView, RoomView, RoomScheduleView, RoomViewMessage, SystemEvent } from '@beeline/api-contract/phone';
import { type PhoneOperationMap, type ArtifactAttachment } from '@beeline/api-contract/phone';
import { type AgentGrantStatus } from '@beeline/api-contract/agent-grants';
import { chatCornerCounts, type ChatCornerSummary, type OpenCornerFactsRow } from '../chat-corner-counts.js';
import { CORNER_ROW_ROOM_COLUMNS } from '../corner-row-projection.js';
import { reviveDates } from './read-projection.js';



export type Input<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['input'];

export type Output<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['output'];


export interface RoomRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  created_by: string | null;
  name: string;
  about: string | null;
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
  reviewer_agent_id: string | null;
  created_at: Date;
  updated_at: Date;
  leave_deletes_room?: boolean;
}

export interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  text: string;
  presentation: RoomViewMessage['presentation'];
  deleted_at?: Date | null;
  bookmarked?: boolean;
  feedback_reported?: boolean;
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
  source_client?: { id: string; name: string } | null;
  agent_model: string | null;
  activity: unknown[] | null;
  durable_fact: RoomViewMessage['durableFact'] | null;
  card_type: string | null;
  card: Record<string, unknown> | null;
  system_event: SystemEvent | null;
  created_at: Date;
  version?: number;
  author_kind: 'human' | 'agent';
  author_name: string;
  author_handle: string | null;
  author_avatar: string | null;
  author_face: string | null;
}

export interface AgentTurnRow {
  request_id: string;
  agent_id: string;
  status: 'working' | 'complete' | 'failed' | 'cancelled';
  started_at: Date;
  created_at: Date;
  generation_id: string | null;
  requested_by: string | null;
}

export interface MemberRow extends IdentityRow {
  role: 'owner' | 'admin' | 'member' | 'spectator';
  presence_body: { status: 'online' | 'offline'; observedAt: number; held?: unknown } | null;
  presence_updated_at: Date | null;
}

export type McpClientIdentity = { name: string; redirects: string[] };


/** Registered app identity wins over legacy model placeholders for joined members. */
export function mcpClientIdentitySql(agentId: string): string {
  return `(SELECT jsonb_build_object('name',client.name,'redirects',client.redirects)
    FROM rooms_mcp_members member JOIN rooms_mcp_clients client ON client.id=member.client_id
    WHERE member.member_id=${agentId})`;
}


/** A roster agent row with the configuration its Members row shows. */
export type RosterAgentRow = MemberRow & AgentUsageRow & {
  mcp_client: McpClientIdentity | null;
  selected_model: string | null;
  model_catalog: AgentDetailView['catalog'] | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_handle: string | null;
};

export interface AgentGrantRow {
  id: string; kind: AgentGrantView['kind']; target: string; reason: string;
  status: AgentGrantStatus; room_id: string; auto: boolean;
  created_at: Date; decided_at: Date | null; expires_at: Date | null;
  requester: IdentityRow; decider: IdentityRow | null; script: unknown;
}

export type RoomHeaderRow = Pick<RoomRow, 'id' | 'workspace_id' | (typeof CORNER_ROW_ROOM_COLUMNS)[number]>;

export type CornerRow = RoomHeaderRow & OpenCornerFactsRow & {
  objective: string | null;
  initiator_id: string | null;
  initiator_name: string | null;
  initiator_handle: string | null;
  initiator_avatar: string | null;
  initiator_face: string | null;
  latest_id: string | null;
  latest_text: string | null;
  latest_author_id: string | null;
  latest_author_kind: 'human' | 'agent' | null;
  latest_author_name: string | null;
  /** `archived_at` in whole microseconds, exact, for the archived page cursor. */
  archived_us: string | null;
  created_us: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_handle: string | null;
  agent_avatar: string | null;
  latest_turn_created_at: Date | null;
  /** The corner's latest brief revision; null when it has no brief. */
  brief_revision: number | null;
};

/** The parent Room row's corner facts, read with its corner list. */
export interface DeckCornerFacts {
  needs_you: boolean;
  working: boolean;
  attention_actor: string | null;
  corner_rows: OpenCornerFactsRow[];
}


/** The parent Room row's corner summary from its corner facts. */
export function deckCornerSummary(roomId: string, deck: DeckCornerFacts): ChatCornerSummary {
  return chatCornerCounts(deck.corner_rows.map((corner) =>
    reviveDates(corner, ['archived_at', 'latest_created_at']))).get(roomId) ?? {
    cornerCount: 0, waitingCornerCount: 0, mineCornerCount: 0, openCorners: [],
  };
}

export interface RoomReadEnrichment {
  presence: Array<{ id: string; presence_body: MemberRow['presence_body']; presence_updated_at: Date | null }>;
  tags: Array<{ id: string; tagged_ids: string[] }>;
  bookmarks: Array<{ message_id: string }>;
  reports: Array<{ trigger_message_id: string }>;
  expired: Array<{ id: string }>;
  objects: Array<{ id: string; title: string; mime: string; size: string; author: string }>;
  allow_auto_merge: boolean | null;
}

export interface RoomReadRow {
  starter_onboarding_pending: boolean;
  room: RoomRow & {
    viewer_push_muted: boolean;
    workspace_role: 'owner' | 'admin' | 'member' | 'spectator';
    read_cursor: RoomView['viewer']['readCursor'] | null;
  };
  members: MemberRow[];
  turns: AgentTurnRow[];
  pending_commands: Array<{ agent_id: string; turn_request_id: string; created_at: Date }>;
  transcript: MessageRow[];
  activity: MessageRow[];
  allow_auto_merge?: boolean;
  corner: {
    parent: RoomRow | null;
    facts: {
      plan: RoomView['cornerPlan'] | null;
      objective: string;
      owner_agent_id: string | null;
      locked: boolean;
      lifecycle: NonNullable<RoomView['cornerLifecycle']> | null;
    } | null;
    owed: boolean;
    brief: CornerBriefRow | null;
    briefing: MessageRow[];
    tools: MessageRow[];
  } | null;
}

export interface RoomScheduleRow {
  paused_at: Date | null;
  id: string;
  workspace_id: string;
  room_id: string;
  agent_id: string;
  creator_id: string;
  title: string | null;
  max_runs: number | null;
  cadence: RoomScheduleView['cadence'];
  message: string;
  next_run_at: Date;
  created_at: Date;
  surface_parent_id?: string | null;
  surface_name?: string;
  workflow_slug: string | null;
  run_count: number;
}


/** Expiry tombstones and artifact facts, collected in one read. */
export interface AttachmentFacts {
  expired: ReadonlySet<string>;
  artifacts: ReadonlyMap<string, ArtifactAttachment>;
}
