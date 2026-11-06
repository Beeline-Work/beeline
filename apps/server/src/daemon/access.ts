import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerReviewerSql } from '../corner-reviewer.js';
import { agentMemberMetadata } from '../agent-member-metadata.js';
import type { DaemonContext } from './context.js';
import { AccessDeniedError, id } from './values.js';


  export async function daemonIdentity(ctx: DaemonContext, agentId: string) {
    const row = (
      await ctx.database.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [
        agentId,
      ])
    ).rows[0];
    return {
      pubkey: agentId,
      kind: 'agent' as const,
      name: row?.name ?? systemMessage("daemon-service.agent", agentId.slice(0, 8)),
    };
  }

  /** A review assignment lends transcript reads only in its current approval source. */
  export async function daemonReviewSourceAccess(ctx: DaemonContext, roomId: string, agentId: string): Promise<void> {
    const result = await ctx.database.query(
      `SELECT 1
       FROM rooms source
       JOIN rooms corner ON corner.workspace_id=source.workspace_id AND corner.archived_at IS NULL
       JOIN corner_github_cache fact ON fact.corner_id=corner.id
       JOIN LATERAL (SELECT corner_brief_revisions.* FROM corner_brief_revisions
         WHERE corner_id=corner.id ORDER BY revision DESC LIMIT 1) brief
         ON brief.source_room_id=source.id
       JOIN agent_commands command ON command.room_id=corner.id AND command.agent_id=$2
         AND command.state IN ('pending','claimed') AND command.review_context IS NOT NULL
         AND command.review_context->>'purpose' IS NULL
         AND command.review_context->>'headSha'=fact.lifecycle->'pr'->>'headSha'
         AND command.review_context->'pullRequest'=fact.lifecycle->'pr'->'number'
         AND command.review_context->>'briefRevision'=brief.revision::text
       JOIN room_access member ON member.room_id=corner.id
         AND member.identity_id=$2 AND member.removed_at IS NULL
       WHERE source.id=$1 AND EXISTS(SELECT 1 FROM messages approval
         WHERE approval.id=brief.source_message_id AND approval.room_id=source.id
           AND approval.deleted_at IS NULL)
       LIMIT 1`,
      [roomId, agentId],
    );
    if (!result.rowCount) throw new AccessDeniedError();
  }


  /**
   * Membership, plus the one thing the caller would otherwise need a second
   * round trip to learn: whether this agent is the configured reviewer of the
   * corner it is writing into. Only such an agent can be ending a review, so
   * the review handoff asks its own question only for them, and an ordinary
   * Room reply — the hottest write in the product — pays nothing for it.
   */
  export async function daemonAccess(ctx: DaemonContext, roomId: string, agentId: string, requestId?: unknown): Promise<{ cornerReviewer: boolean; isCorner: boolean; privateCommand: boolean; voiceAgentName?: string | null }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId))
      throw new AccessDeniedError();
    const result = await ctx.database.query<{ corner_reviewer: boolean; is_corner: boolean; private_command: boolean; voice_agent_name: string | null }>(
      `SELECT EXISTS(
         SELECT 1 FROM rooms corner JOIN rooms parent ON parent.id=corner.parent_id
         WHERE corner.id=$1 AND (
           ${cornerReviewerSql('corner')}=$2)
       ) corner_reviewer,
       EXISTS(SELECT 1 FROM rooms corner WHERE corner.id=$1 AND corner.parent_id IS NOT NULL) is_corner,
       EXISTS(SELECT 1 FROM agent_commands command WHERE command.room_id=$1 AND command.agent_id=$2
         AND command.turn_request_id=$3 AND command.private_payload IS NOT NULL) private_command,
       (SELECT identity.name FROM agent_commands command
         JOIN voice_orders voice ON voice.source_message_id=command.source_message_id AND voice.agent_id=command.agent_id
         JOIN identities identity ON identity.id=command.agent_id
         WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
         ORDER BY command.created_at DESC,command.id DESC LIMIT 1) voice_agent_name
       FROM rooms addressed
       JOIN memberships parent_member ON parent_member.room_id=COALESCE(addressed.parent_id,addressed.id)
         AND parent_member.identity_id=$2 AND parent_member.removed_at IS NULL
       WHERE addressed.id=$1`,
      [roomId, agentId, typeof requestId === 'string' ? requestId : null],
    );
    if (!result.rowCount) throw new AccessDeniedError();
    const row = result.rows[0]!;
    return { cornerReviewer: row.corner_reviewer, isCorner: row.is_corner, privateCommand: row.private_command, voiceAgentName: row.voice_agent_name };
  }


  export async function daemonRoomMembers(ctx: DaemonContext, roomId: string) {
    const rows = await ctx.database.query<{
      id: string;
      kind: 'human' | 'agent';
      name: string;
      handle: string | null;
      role: string;
    }>(
      `SELECT identity.id,identity.kind,identity.name,identity.handle,
         COALESCE(workspace_member.role,member.role) role
       FROM memberships member JOIN identities identity ON identity.id=member.identity_id
       LEFT JOIN memberships workspace_member ON workspace_member.workspace_id=member.workspace_id
         AND workspace_member.room_id IS NULL AND workspace_member.identity_id=member.identity_id
         AND workspace_member.removed_at IS NULL
       WHERE member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=$1) AND member.removed_at IS NULL
       ORDER BY identity.kind,identity.name`,
      [roomId],
    );
    return { members: await agentMemberMetadata(ctx.database, rows.rows, roomId) };
  }
