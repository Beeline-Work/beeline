import { commandOwnerFenceCteSql, commandOwnerFenceMatchesSql, commandOwnerLiveSql } from '../turn-ownership.js';
import { cornerRequestSql } from '../corner-opening.js';
import { mentionReplyKey, mentionReplyId } from '../owed-mentions.js';
import { visibleMessageSql } from '../read-cursor.js';
import { sanitizeTurnReplay } from '@beeline/api-contract/daemon';
import { observeOnboardingMessage } from '../signin-funnel.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { refuseTagPastCommander, CommandRefusalError } from '../commander.js';
import { authorizeCommandOutput, turnRootMessageSql } from '../agent-command.js';
import { randomBytes } from 'node:crypto';
import { type SqlDatabase } from '../database.js';
import { type CommittedMessageLiveRow } from '../live.js';
import { taggedIdentityIdsSql } from '../message-mentions.js';
import { recordStarPromptReply, starPromptReplySql } from '../github-star-prompt.js';
import type { DaemonContext } from './context.js';
import { Input, replySteps, id, MAX_REPLY_NOTE_LENGTH, seconds, MEDIA_URL_PATTERN } from './values.js';
import { daemonAccess } from './access.js';
import { daemonWriteResult } from './corner-messages.js';


  export async function daemonCompletion(ctx: DaemonContext, input: Input<'getRequestCompletion'>, agentId: string) {
    await daemonAccess(ctx, input.roomId, agentId);
    const row = (
      await ctx.database.query<{ corner_id: string | null; status: 'complete' | 'failed' | null; failure_reason: string | null }>(
        `SELECT (SELECT id::text FROM rooms WHERE parent_id=$1 AND ${cornerRequestSql('rooms.id')}=$2 LIMIT 1) corner_id,
          ended.status,ended.failure_reason FROM (SELECT 1) anchor LEFT JOIN LATERAL (
            SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND status IN ('complete','failed')
            ORDER BY created_at DESC LIMIT 1) ended ON true`,
        [input.roomId, input.requestId],
      )
    ).rows[0]!;
    return { ...(row.corner_id ? { openedCornerId: row.corner_id } : {}), completed: Boolean(row.status),
      ...(row.status ? { outcome: row.status, ...(row.failure_reason ? { failureReason: row.failure_reason } : {}) } : {}) };
  }

  export async function daemonPostRoomMessage(ctx: DaemonContext, 
    input: Input<'postRoomMessage'>,
    agentId: string,
    atomicCommandWrite = false,
  ) {
    if (!ctx.commandTransaction && !atomicCommandWrite) await daemonAccess(ctx, input.roomId, agentId);
    if ('relay' in input) throw new CommandRefusalError('relay cards are retired; use order and report', 410);
    let steps = replySteps(input.steps);
    // Explicit same-address posts can already have
    // committed a message. Keep the closing text in turn activity regardless
    // of wording, rather than publishing a second conversation message.
    const earlier = input.requestId && input.presentation !== 'card'
      ? (await ctx.database.query<{ id: string; text: string }>(
          `SELECT id,text FROM messages
           WHERE room_id=$1 AND author_id=$2 AND request_id=$3
             AND presentation='message' AND deleted_at IS NULL
             AND legacy_event->>'turnGenerationId'=$4
           ORDER BY created_at DESC,id DESC LIMIT 64`,
          [input.roomId, agentId, input.requestId, input.generationId],
        )).rows
      : [];
    const repeated = Boolean(ctx.commandTransaction && earlier.length);
    if (repeated) {
      const notes = Array.from({ length: Math.ceil(input.text.length / MAX_REPLY_NOTE_LENGTH) }, (_, index) => ({
        kind: 'note' as const, title: 'Turn summary',
        text: input.text.slice(index * MAX_REPLY_NOTE_LENGTH, (index + 1) * MAX_REPLY_NOTE_LENGTH),
        ...(index ? { continues: true as const } : {}),
      }));
      steps = replySteps([...(input.steps ?? []), ...notes], notes.length);
    }
    const mentionKey = await mentionReplyKey(ctx.database, agentId, input.roomId, input.replyToMessageId);
    const messageId = mentionKey ? mentionReplyId(mentionKey) : id();
    const parent = input.replyToMessageId
      ? (
          await ctx.database.query<{
            root_message_id: string | null;
            agent_hop_count: number;
            author_kind: 'human' | 'agent';
          }>(
            `SELECT message.root_message_id,message.agent_hop_count,identity.kind author_kind
             FROM messages message JOIN identities identity ON identity.id=message.author_id
             WHERE message.id=$1 AND message.room_id=$2`,
            [input.replyToMessageId, input.roomId],
          )
        ).rows[0]
      : undefined;
    if (input.replyToMessageId && !parent) throw new Error('reply parent is not in this room');
    const command = atomicCommandWrite
      ? undefined
      : (ctx.authorizedCommand ??
        (await authorizeCommandOutput(
          ctx.database,
          input.roomId,
          agentId,
          input.requestId,
          input.generationId,
        )));
    if (command && input.presentation !== 'card')
      await refuseTagPastCommander(ctx.database, input.roomId, agentId, input.text, command);
    // A tag an agent writes reaches the person it names, exactly as a
    // human-authored one does: the same reading of the text, the same push
    // fan-out, the same highlight. There is no per-turn numeric cap, and no
    // list is frozen here — `message-mentions.ts` reads the tags back out of
    // this text whenever someone asks who it addresses.
    const rootMessageId = input.replyToMessageId
      ? (parent!.root_message_id ?? input.replyToMessageId)
      : null;
    // Turns are unthreaded by design. Count from the inbox item that woke this
    // agent, not the optional presentation reply parent; a human item starts a
    // fresh chain at zero.
    const hopCount = command?.agent_depth ?? 0;
    let messageWriteStartedAt: number | undefined;
    const saveCompatibilityReply = async (database: SqlDatabase) => {
      // Attachments queued this turn by beeline-agent post_artifact ride on this
      // final reply; they are drained exactly once, here.
      const pending = (
        await database.query<{
          url: string;
          name: string;
          mime_type: string;
          size: number;
        }>(
          `SELECT url,name,mime_type,size::integer AS size FROM agent_pending_attachments
           WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND generation_id=$4 ORDER BY created_at,id`,
          [input.roomId, agentId, input.requestId, input.generationId],
        )
      ).rows;
      if (pending.length)
        await database.query(
          `DELETE FROM agent_pending_attachments WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND generation_id=$4`,
          [input.roomId, agentId, input.requestId, input.generationId],
        );
      const values = [
        messageId,
        input.roomId,
        agentId,
        input.text,
        // The daemon posts conversation (or a card); a system line is only
        // ever phrased by the server (`system-line.ts`).
        input.presentation === 'card' ? 'card' : 'message',
        input.requestId ?? null,
        JSON.stringify(input.tags ?? {}),
        input.replyToMessageId ?? null,
        rootMessageId,
        hopCount,
        JSON.stringify(
          pending.map((row) => ({
            url: row.url,
            name: row.name,
            mimeType: row.mime_type,
            size: row.size,
          })),
        ),
        steps,
      ];
      if (ctx.commandTransaction) {
        return (
          await database.query<CommittedMessageLiveRow>(
            `WITH new_messages AS (
               INSERT INTO messages(
                 id,room_id,author_id,text,presentation,request_id,legacy_event,
                 reply_to_message_id,root_message_id,agent_hop_count,attachments,activity,agent_model
               ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,
                 (SELECT selected_model FROM agents WHERE agent_id=$3))
               ON CONFLICT(id) DO NOTHING
               RETURNING *
             ), inserted AS (
               SELECT * FROM new_messages UNION ALL
               SELECT stored.* FROM messages stored WHERE stored.id=$1 AND stored.room_id=$2 AND stored.author_id=$3
                 AND NOT EXISTS(SELECT 1 FROM new_messages)
             ), completed AS (
               SELECT beeline_end_agent_turn($13,$14,'complete',NULL,inserted.id) ended
               FROM inserted WHERE $15::boolean
             ), cleared AS (
               DELETE FROM live_outputs
               WHERE room_id=$2 AND agent_id=$3 AND turn_id=$6 AND kind IN ('draft','thought') AND NOT $15::boolean
             )
             SELECT inserted.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
               ${taggedIdentityIdsSql('inserted')} tagged_ids
             FROM inserted JOIN identities author ON author.id=inserted.author_id
             CROSS JOIN (SELECT count(*) FROM completed) completion`,
            [...values, command!.id, command!.generation_id, command!.private_payload?.kind !== 'order'],
          )
        ).rows[0]!;
      }
      return (
        await database.query<CommittedMessageLiveRow>(
          `WITH new_messages AS (
             INSERT INTO messages(
               id,room_id,author_id,text,presentation,request_id,legacy_event,
               reply_to_message_id,root_message_id,agent_hop_count,attachments,activity,agent_model
             ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,
               (SELECT selected_model FROM agents WHERE agent_id=$3))
             ON CONFLICT(id) DO NOTHING
             RETURNING *
           ), inserted AS (
             SELECT * FROM new_messages UNION ALL
             SELECT stored.* FROM messages stored WHERE stored.id=$1 AND stored.room_id=$2 AND stored.author_id=$3
               AND NOT EXISTS(SELECT 1 FROM new_messages)
           )
           SELECT inserted.*,author.kind author_kind,author.name author_name,
             author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
             ${taggedIdentityIdsSql('inserted')} tagged_ids
           FROM inserted JOIN identities author ON author.id=inserted.author_id`,
          values,
        )
      ).rows[0]!;
    };
    let saved: CommittedMessageLiveRow;
    let databaseAwaitResolvedAt: number | undefined;
    let projectionCompletedAt: number | undefined;
    if (atomicCommandWrite) {
      type AtomicReplyResult = {
        outcome:
          | 'committed'
          | 'authority_rejected'
          | 'turn_cancelled'
          | 'already_completed'
          | 'no_reply'
          | 'result_conflict'
          | 'write_failed';
        row: (Omit<CommittedMessageLiveRow, 'created_at'> & { created_at: string }) | null;
      };
      // One autocommit statement owns the lock, generation/lease/cancellation
      // decision, attachment drain, terminal turn/failure state, reply insert,
      // command completion, and live-output cleanup. PostgreSQL commits the
      // statement before query() resolves, so the live row remains authoritative.
      messageWriteStartedAt = Date.now();
      const query = await ctx.database.query<AtomicReplyResult>(
        `WITH ${commandOwnerFenceCteSql('owned_command.room_id=$2 AND owned_command.agent_id=$3 AND owned_command.turn_request_id=$6 AND owned_command.generation_id=$10')}, candidate AS MATERIALIZED (
             SELECT command.*,
               EXISTS(SELECT 1 FROM agent_turns turn
                 WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
                   AND turn.request_id=command.turn_request_id AND turn.status='cancelled') turn_cancelled,
               EXISTS(SELECT 1 FROM agent_turns turn
                 WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
                   AND turn.request_id=command.turn_request_id AND turn.completion_kind='no-reply') no_reply
             FROM agent_commands command
             WHERE command.room_id=$2 AND command.agent_id=$3 AND command.turn_request_id=$6
               AND command.action IN ('input','resume') AND command.generation_id=$10
               AND ${commandOwnerFenceMatchesSql('command')}
             ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command
           ), writable AS (
             SELECT * FROM candidate
             WHERE state='claimed' AND ${commandOwnerLiveSql(undefined, 'clock_timestamp()')} AND NOT turn_cancelled AND NOT no_reply
               AND (turn_owner_connection_id IS NULL OR beeline_register_owned_effect(id,agent_id,generation_id,turn_owner_connection_id,turn_owner_epoch))
           ), pending AS (
             DELETE FROM agent_pending_attachments attachment USING writable
             WHERE attachment.room_id=$2 AND attachment.agent_id=$3
               AND attachment.request_id=$6 AND attachment.generation_id=$10
             RETURNING attachment.url,attachment.name,attachment.mime_type,attachment.size,
               attachment.created_at,attachment.id
           ), attachment_payload AS (
             SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'url',url,'name',name,'mimeType',mime_type,'size',size::integer
             ) ORDER BY created_at,id),'[]'::jsonb) attachments FROM pending
           ), settled AS (
             SELECT 1 FROM writable
           ), new_messages AS (
             INSERT INTO messages(
               id,room_id,author_id,text,presentation,request_id,legacy_event,
               reply_to_message_id,root_message_id,agent_hop_count,attachments,activity,agent_model
             ) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,
                 writable.agent_depth,attachment_payload.attachments,$11::jsonb,
                 (SELECT selected_model FROM agents WHERE agent_id=$3)
               FROM writable,settled,attachment_payload
             ON CONFLICT(id) DO NOTHING
             RETURNING *
           ), inserted AS (
             SELECT * FROM new_messages UNION ALL
             SELECT stored.* FROM messages stored WHERE stored.id=$1 AND stored.room_id=$2 AND stored.author_id=$3
               AND NOT EXISTS(SELECT 1 FROM new_messages)
           ), completed AS (
             SELECT (ended).* FROM (SELECT beeline_end_agent_turn(writable.id,writable.generation_id,'complete',NULL,inserted.id) ended FROM writable,inserted) ended_commands
           ), star_count AS (
             ${starPromptReplySql(
               `(SELECT writable.root_source_message_id FROM writable,completed WHERE $5='message')`,
             )}
           ), inserted_public AS (
             SELECT inserted.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
               ${taggedIdentityIdsSql('inserted')} tagged_ids
             FROM inserted JOIN identities author ON author.id=inserted.author_id
             CROSS JOIN completed
           ), existing_public AS (
             SELECT message.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
               ${taggedIdentityIdsSql('message')} tagged_ids
             FROM candidate JOIN messages message ON message.id=candidate.result_message_id
             JOIN identities author ON author.id=message.author_id
             WHERE candidate.state='complete' AND message.text=$4
           ), committed AS (
             SELECT * FROM inserted_public UNION ALL SELECT * FROM existing_public
           )
           SELECT 'committed'::text outcome,to_jsonb(committed) row
           FROM committed
           UNION ALL
           SELECT CASE
             WHEN NOT EXISTS(SELECT 1 FROM candidate) THEN 'authority_rejected'
             WHEN (SELECT turn_cancelled FROM candidate) THEN 'turn_cancelled'
             WHEN (SELECT no_reply FROM candidate) THEN 'no_reply'
             WHEN (SELECT state FROM candidate)='complete'
               AND (SELECT result_message_id FROM candidate) IS NULL THEN 'already_completed'
             WHEN (SELECT state FROM candidate)='complete' THEN 'result_conflict'
             ELSE 'write_failed'
           END outcome,NULL::jsonb row
           WHERE NOT EXISTS(SELECT 1 FROM committed)
           LIMIT 1`,
        [
          messageId,
          input.roomId,
          agentId,
          input.text,
          input.presentation === 'card' ? 'card' : 'message',
          input.requestId ?? null,
          JSON.stringify(input.tags ?? {}),
          input.replyToMessageId ?? null,
          rootMessageId,
          input.generationId,
          steps,
        ],
      );
      if (ctx.livePaintDiagnostics) databaseAwaitResolvedAt = Date.now();
      const result = query.rows[0];
      if (!result || result.outcome === 'write_failed')
        throw new Error('command output authority rejected');
      if (result.outcome === 'authority_rejected')
        throw new Error('command output authority rejected');
      if (result.outcome === 'turn_cancelled') throw new Error('command turn cancelled');
      if (result.outcome === 'no_reply') return daemonWriteResult(ctx);
      if (result.outcome === 'already_completed') throw new Error('command already completed');
      if (result.outcome === 'result_conflict') throw new Error('command result conflict');
      if (!result.row) throw new Error('command output authority rejected');
      saved = { ...result.row, created_at: new Date(result.row.created_at) };
      if (ctx.livePaintDiagnostics) projectionCompletedAt = Date.now();
    } else {
      saved = await ctx.database.transaction(saveCompatibilityReply);
    }
    if (repeated && ctx.commandTransaction && saved.presentation === 'message') {
      // Deliver queued artifacts on the existing public post, so suppressing
      // closing prose never hides the turn's deliverable.
      if (saved.attachments.length) {
        await ctx.database.query(`UPDATE messages SET attachments=attachments || $2::jsonb WHERE id=$1`,
          [earlier[0]!.id, JSON.stringify(saved.attachments)]);
        await ctx.database.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id=$1`, [saved.id]);
        saved = { ...saved, attachments: [] };
        ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message', agentId, messageId: earlier[0]!.id });
      }
      // This is still inside the authorized command transaction. System/card
      // producers keep their existing insert path and are never demoted here.
      const demoted = (await ctx.database.query<{ presentation: 'activity'; version: number }>(
        `UPDATE messages SET presentation='activity'
         WHERE id=$1 AND room_id=$2 AND author_id=$3 AND presentation='message'
         RETURNING presentation,version`,
        [saved.id, input.roomId, agentId],
      )).rows[0];
      if (demoted) saved = { ...saved, ...demoted };
    }
    const emittedAt = Date.now();
    ctx.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'message',
      agentId,
      messageId,
      committedRow: {
        type: 'message',
        row: saved,
        ...(messageWriteStartedAt ? { startedAt: messageWriteStartedAt } : {}),
      },
      ...(messageWriteStartedAt
        ? {
            trace: {
              id: randomBytes(16).toString('hex'),
              databaseAt: saved.created_at.getTime(),
              emittedAt,
              startedAt: messageWriteStartedAt,
              ...(databaseAwaitResolvedAt ? { databaseAwaitResolvedAt } : {}),
              ...(projectionCompletedAt ? { projectionCompletedAt } : {}),
              ...(ctx.livePaintDiagnostics && ctx.liveDiagnosticServerInstance
                ? { serverInstance: ctx.liveDiagnosticServerInstance }
                : {}),
            },
          }
        : {}),
    });
    if (saved.presentation === 'message') {
      const depth = (saved as CommittedMessageLiveRow & { agent_hop_count?: number }).agent_hop_count
        ?? ctx.authorizedCommand?.agent_depth;
      // Observe committed replies without delaying their publication or acknowledgement.
      const observe = async (database: SqlDatabase) => {
        const work = () => observeOnboardingMessage(database, input.roomId, agentId, depth, input.text)
          .catch(error => console.error('[onboarding]', error));
        const backgroundWork = CornerAccessDatabase.physical(database).backgroundWork;
        if (backgroundWork) backgroundWork.run(work);
        else await work();
      };
      if (ctx.afterCommit) ctx.afterCommit(observe);
      else await observe(ctx.database);
    }
    // The atomic reply statement counted it in its own star_count CTE.
    if (!atomicCommandWrite && input.requestId && input.presentation !== 'card') {
      const reply = {
        roomId: input.roomId,
        agentId,
        requestId: input.requestId,
        messageId: saved.id,
      };
      const count = (database: SqlDatabase) => recordStarPromptReply(database, reply);
      if (ctx.afterCommit) ctx.afterCommit(count);
      else
        await count(ctx.database).catch((error) =>
          console.error('[daemon] star prompt reply count failed', error),
        );
    }
    return {
      id: saved.id,
      createdAt: seconds(saved.created_at),
    };
  }

  /** An agent-claimed attachment queued by post_artifact; stamped onto the agent's
   *  next final Room reply. Only media this agent uploaded through the daemon
   *  media endpoint may be queued. */
  export async function daemonPostAgentAttachment(ctx: DaemonContext, input: Input<'postAgentAttachment'>, agentId: string) {
    const attachment = input.attachment;
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment))
      throw new Error('attachment is required');
    if (typeof attachment.url !== 'string' || typeof attachment.name !== 'string')
      throw new Error('attachment url and name are required');
    if (
      typeof attachment.size !== 'number' ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size <= 0
    )
      throw new Error('attachment size is invalid');
    if (attachment.name.length > 512) throw new Error('attachment name is too long');
    if (typeof attachment.mimeType !== 'string' || attachment.mimeType.length > 255)
      throw new Error('attachment mimeType is invalid');
    const mediaId = MEDIA_URL_PATTERN.exec(attachment.url)?.[1];
    if (!mediaId) throw new Error('attachment url is not a server media reference');
    const owned = await ctx.database.query(
      `SELECT 1 FROM objects
        WHERE id=$1 AND owner_id=$2 AND state='ready' AND expires_at > now()`,
      [mediaId, agentId],
    );
    if (!owned.rowCount) throw new Error('attachment media is not owned by this agent');
    const queued = await ctx.database.query<{ total: string }>(
      `SELECT COALESCE(SUM(size),0)::text total FROM agent_pending_attachments
       WHERE room_id=$1 AND agent_id=$2`,
      [input.roomId, agentId],
    );
    const usedBytes = Number(queued.rows[0]!.total);
    if (usedBytes + attachment.size > ctx.mediaMaximumBytes)
      throw new CommandRefusalError(
        `Queued attachments exceed the ${ctx.mediaMaximumBytes}-byte total limit per reply: ` +
          `${usedBytes} bytes already queued; artifact size: ${attachment.size} bytes. ` +
          'Use smaller files, or deliver the queued attachments with your next reply or report before posting more.',
        400,
      );
    await ctx.database.query(
      `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id,generation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.roomId,
        agentId,
        attachment.url,
        attachment.name,
        attachment.mimeType,
        attachment.size,
        input.requestId,
        input.generationId,
      ],
    );
    return daemonWriteResult(ctx);
  }

  export async function daemonLiveOutput(ctx: DaemonContext, 
    kind: 'draft' | 'thought',
    input: Input<'postAgentDraft'>,
    agentId: string,
  ) {
    await daemonAccess(ctx, input.roomId, agentId);
    const written = await ctx.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       SELECT room.id,$2,$3,$4,$5::jsonb FROM rooms room
       WHERE room.id=$1 AND ($4<>'draft' OR room.parent_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM messages visit JOIN agent_commands command ON command.room_id=visit.room_id
           AND visit.card->'outputCommandIds' ? command.id
         WHERE visit.room_id=$1 AND visit.card_type='workflow-handoff'
           AND command.agent_id=$2 AND command.turn_request_id=$3 AND command.state='claimed'
       ))
       ON CONFLICT(room_id,agent_id,turn_id,kind)
       DO UPDATE SET body=EXCLUDED.body,updated_at=now()
       RETURNING 1`,
      [input.roomId, agentId, input.turnId, kind, JSON.stringify({ text: input.text, latestChunk: input.latestChunk })],
    );
    // Room turns keep their durable working receipt and final reply, but their
    // provisional prose stays off the transcript. Corners retain the full
    // draft stream so repository work remains observable while it is running.
    if (!written.rowCount) return daemonWriteResult(ctx);
    ctx.live.publish({
      type: kind,
      roomId: input.roomId,
      agentId,
      turnId: input.turnId,
      text: input.text,
      ...(input.latestChunk !== undefined ? { latestChunk: input.latestChunk } : {}),
      localOrigin: true,
    });
    return daemonWriteResult(ctx);
  }

  export async function daemonRetract(ctx: DaemonContext, input: Input<'retractAgentLiveOutput'>, agentId: string) {
    await ctx.database.query(
      `DELETE FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind=$4`,
      [input.roomId, agentId, input.turnId, input.kind],
    );
    ctx.live.publish({
      type: 'retract',
      roomId: input.roomId,
      agentId,
      turnId: input.turnId,
      kind: input.kind,
    });
    return daemonWriteResult(ctx);
  }

  export async function daemonPersistTurnTrace(ctx: DaemonContext, database: SqlDatabase, input: Input<'postAgentTurnReceipt'>, agentId: string): Promise<void> {
    // Diagnostics share the receipt transaction, but cannot fail the receipt.
    // IDs come from committed server rows, never a helper's claimed reply.
    if (!input.heartbeat && input.status !== 'working' && input.trace) {
      await database.query('SAVEPOINT turn_trace');
      try {
        const trace = sanitizeTurnReplay(input.trace);
        if (trace) await database.query(
          `INSERT INTO agent_turn_traces(room_id,request_id,agent_id,trigger_message_id,
                                        reply_message_ids,outcome,trace)
           SELECT turn.room_id,turn.request_id,turn.agent_id,
             (SELECT id FROM messages WHERE id=${turnRootMessageSql('turn')}),
             COALESCE((SELECT jsonb_agg(reply.id ORDER BY reply.created_at,reply.id) FROM messages reply
               WHERE reply.room_id=turn.room_id AND reply.author_id=turn.agent_id
                 AND reply.request_id=turn.request_id AND reply.presentation IN ('message','card')
                 AND ${visibleMessageSql('reply')}),'[]'::jsonb),turn.status,$4::jsonb
           FROM agent_turns turn WHERE room_id=$1 AND request_id=$2 AND agent_id=$3
           ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
             trigger_message_id=EXCLUDED.trigger_message_id,
             reply_message_ids=EXCLUDED.reply_message_ids,outcome=EXCLUDED.outcome,
             trace=EXCLUDED.trace,created_at=now()`,
          [input.roomId,input.requestId,agentId,JSON.stringify(trace)],
        );
        await database.query('RELEASE SAVEPOINT turn_trace');
      } catch {
        await database.query('ROLLBACK TO SAVEPOINT turn_trace');
        await database.query('RELEASE SAVEPOINT turn_trace');
        console.warn('[turn-trace] trace dropped');
      }
    }
  }
