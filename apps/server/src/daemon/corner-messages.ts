import { mentionReplyKey, mentionReplyId } from '../owed-mentions.js';
import { agentPostText } from '../agent-post-text.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { refuseTagPastCommander, CommandRefusalError } from '../commander.js';
import { authorizeCommandOutput, routeAgentResult } from '../agent-command.js';
import { MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';
import { type SqlDatabase } from '../database.js';
import type { DaemonContext } from './context.js';
import { Input, id, seconds, AccessDeniedError, Output } from './values.js';



  /** A public message; tags use the same conversation wake rule as final replies. */
  export async function daemonPostCornerMessage(ctx: DaemonContext, input: Input<'postCornerMessage'>, agentId: string) {
    const rawText = typeof input.text === 'string' ? input.text.trim() : '';
    if (!rawText || rawText.length > 16000) throw new Error('message text must be 1 to 16000 characters');
    const text = agentPostText(rawText);
    if (!text) throw new CommandRefusalError('post refused: reasoning block contains no public reply', 400);
    await daemonPostAddressAccess(ctx, input.cornerId, agentId);
    const command = ctx.authorizedCommand ?? await authorizeCommandOutput(
      ctx.database, input.roomId, agentId, input.requestId, input.generationId,
    );
    await refuseTagPastCommander(ctx.database, input.cornerId, agentId, text,
      command.room_id === input.cornerId.toLowerCase() ? command : undefined);
    let root: string | null = null;
    if (input.replyTo !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(input.replyTo)) throw new CommandRefusalError('Invalid replyTo', 400);
      const parent = (await ctx.database.query<{root: string}>(
        'SELECT COALESCE(root_message_id,id) root FROM messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL', [input.replyTo, input.cornerId])).rows[0];
      if (!parent) throw new CommandRefusalError('reply parent is not in this Room', 400);
      root = parent.root;
    }
    const key = await mentionReplyKey(ctx.database, agentId, input.cornerId, input.replyTo);
    const saved = (
      await ctx.database.query<{ id: string; created_at: Date }>(
        `WITH pending AS (
           DELETE FROM agent_pending_attachments
           WHERE room_id=$5 AND agent_id=$3 AND request_id=$6 AND generation_id=$7
             AND room_id=$2
           RETURNING url,name,mime_type,size,created_at,id
         )
         INSERT INTO messages(id,room_id,author_id,text,presentation,agent_model,request_id,legacy_event,attachments,reply_to_message_id,root_message_id)
         SELECT COALESCE((SELECT prior.id FROM messages prior
           WHERE prior.id=$10 AND prior.room_id=$2 AND prior.author_id=$3
             AND prior.text=$4 AND prior.reply_to_message_id=$8),
           CASE WHEN $10::text IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=$10)
             THEN $10 ELSE $1 END),
           room.id,$3,$4,'message',(SELECT selected_model FROM agents WHERE agent_id=$3),
           CASE WHEN room.id=$5::uuid THEN $6 ELSE NULL END,
           jsonb_build_object('turnGenerationId',$7::text),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('url',url,'name',name,'mimeType',mime_type,'size',size)
             ORDER BY created_at,id) FROM pending),'[]'::jsonb),$8,$9
         FROM rooms room WHERE room.id=$2 AND room.archived_at IS NULL
         ON CONFLICT(id) DO UPDATE SET id=messages.id
         RETURNING id,created_at`,
        // Explicit posts may answer the same mention with different text. A
        // retry of that text keeps its id, while a new post gets its own row.
        // Keep the first post on the shared mention id so an automatic final
        // reply or a retry in another turn cannot deliver the answer again.
        [key ? mentionReplyId(`${key}:${text}`) : id(), input.cornerId, agentId, text, input.roomId, input.requestId, input.generationId, input.replyTo ?? null, root, key ? mentionReplyId(key) : null],
      )
    ).rows[0];
    if (!saved) throw new CommandRefusalError('post refused: address is archived', 409);
    const delivery = await routeAgentResult(ctx.database, command, saved.id, { roomId: input.cornerId, agentId });
    ctx.live.publish({ type: 'invalidate', roomId: input.cornerId, reason: 'message', agentId });
    return { id: saved.id, createdAt: seconds(saved.created_at), effect: 'conversation',
      address: input.cornerId, visibility: 'public', reportsAssignment: false, ...delivery,
      stored: true, visible: true, receipt: 'Message stored and visible.' +
        (input.cornerId === command.room_id
          ? '\nPosted to your current place. Queued files are attached to this post. Closing text is kept in turn activity.'
          : '') };
  }


  /** Public posts accept Rooms and corners without broadening corner-only operations. */
  export async function daemonPostAddressAccess(ctx: DaemonContext, address: string, agentId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(address))
      throw new CommandRefusalError('post refused: unknown address', 400);
    const target = (await new CornerAccessDatabase(ctx.database).query<{
      archived: boolean; member: boolean;
    }>(`SELECT room.archived_at IS NOT NULL AS archived,
        EXISTS(SELECT 1 FROM memberships member
          WHERE member.room_id IN (room.id,room.parent_id)
            AND member.identity_id=$2 AND member.removed_at IS NULL) AS member
        FROM rooms room WHERE room.id=$1`, [address, agentId])).rows[0];
    if (!target) throw new CommandRefusalError('post refused: unknown address', 400);
    if (!target.member) throw new CommandRefusalError('post refused: agent is not a current member of the Room', 403);
    if (target.archived) throw new CommandRefusalError('post refused: address is archived', 409);
  }


  /**
   * An agent reaches a corner when it is a current member of the corner or of
   * its parent Room. Returns the parent Room id.
   */
  export async function daemonReach(ctx: DaemonContext, cornerId: string, agentId: string, database: SqlDatabase = ctx.database) {
    database = new CornerAccessDatabase(database);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cornerId))
      throw new AccessDeniedError();
    const row = (
      await database.query<{ parent_id: string }>(
        `SELECT corner.parent_id FROM rooms corner
         WHERE corner.id=$1 AND corner.parent_id IS NOT NULL
           AND EXISTS(SELECT 1 FROM memberships member
                      WHERE member.room_id IN (corner.id,corner.parent_id)
                        AND member.identity_id=$2 AND member.removed_at IS NULL)`,
        [cornerId, agentId],
      )
    ).rows[0];
    if (!row) throw new AccessDeniedError();
    return row.parent_id;
  }


  /** Adds one fixed-vocabulary reaction without turning a retried tool call into an unreact. */
  export async function daemonReactToRoomMessage(ctx: DaemonContext,
    input: Input<'reactToRoomMessage'>,
    agentId: string,
  ): Promise<Output<'reactToRoomMessage'>> {
    if (!MESSAGE_REACTION_EMOJIS.includes(input.emoji)) throw new Error('reaction is invalid');
    await ctx.database.transaction(async (database) => {
      const row = (
        await database.query<{ reactions: Record<string, string[]> }>(
          `SELECT reactions FROM messages
           WHERE id=$1 AND room_id=$2 AND presentation='message'
           FOR UPDATE`,
          [input.messageId, input.roomId],
        )
      ).rows[0];
      if (!row) throw new CommandRefusalError('message is not available for reaction', 404);
      const reactions = { ...(row.reactions ?? {}) };
      const reactors = new Set(reactions[input.emoji] ?? []);
      reactors.add(agentId);
      reactions[input.emoji] = [...reactors];
      await database.query(`UPDATE messages SET reactions=$3::jsonb WHERE id=$1 AND room_id=$2`, [
        input.messageId,
        input.roomId,
        JSON.stringify(reactions),
      ]);
    });
    ctx.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'message',
      messageId: input.messageId,
      agentId,
    });
    return daemonWriteResult(ctx);
  }

  export function daemonWriteResult(ctx: DaemonContext, extra?: {
    failureReportDelivered?: boolean;
  }) {
    return { id: id(), createdAt: Math.floor(Date.now() / 1000), ...extra };
  }
