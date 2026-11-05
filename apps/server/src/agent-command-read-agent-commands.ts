import { cornerLifecycleSql } from './corner-github-cache.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerObjectiveSql } from './corner-objective.js';
import { commandOwnerLiveSql } from './turn-ownership.js';
import { voiceDateContext } from './voice-reply.js';
import { reportToCommander } from './commander.js';
import { subscriptionPromptBody } from './agent-subscriptions.js';
import { boundReplyExcerpt, REPLY_EXCERPT_MAX_LENGTH } from '@beeline/api-contract/daemon';
import { createHash } from 'node:crypto';
import type { AgentCommand, RoomInboxResult } from '@beeline/api-contract/daemon';
import { isResumeKind } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { advanceCorner, cornerMergeGate, lockCornerLifecycle } from './corner-lifecycle.js';
import { cornerImplementerSql } from './corner-worker.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { CommandRow, commandValidityCtes, ordinaryWakeSql, reviewerQuietSql, waitingReportSql, checkFailureLogBody, reportedHeadBody } from './agent-command.js';
import { WakeDropLog, MergeCard, WorkflowWakeCard, logStaleWakeDrops, mergeCardDetail, workflowWakeDetail, squireDecisionDetail } from './agent-command-route-agent-result.js';
import { createAgentCommand } from './agent-command-create-agent-command.js';



export async function readAgentCommands(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  generation?: string,
): Promise<{ commandProtocol: 1; commands: AgentCommand[] }> {
  const rows = await db.query<
    CommandRow & WakeDropLog & {
      text: string;
      delivered_context: string | null;
      voice_origin: boolean;
      receipt_hint: string | null;
      author_id: string;
      attachments: RoomInboxResult['items'][number]['attachments'];
      system_event: RoomInboxResult['items'][number]['systemEvent'];
      presentation: string;
      reply_to_message_id: string | null;
      reply_to_author_id: string | null;
      reply_to_author_name: string | null;
      reply_to_excerpt: string | null;
      merge_card: MergeCard | null;
      wake_card_type: string | null;
      wake_card: WorkflowWakeCard | null;
      workflow_state: string | null;
      workflow_outcomes: Record<string, string> | null;
      workflow_status: string | null;
      watched_corner_id: string;
      watched_corner_name: string;
      watched_merge_commit: string | null;
      created_at: Date;
    }
  >(
    `WITH ${commandValidityCtes('$1', '$2')}, delivery AS (
     SELECT c.*,EXISTS(SELECT 1 FROM voice_orders voice WHERE voice.source_message_id=c.source_message_id AND voice.agent_id=c.agent_id) voice_origin,c.recovery_context delivered_context,CASE WHEN c.reason='corner_objective' THEN ${cornerObjectiveSql('command_corner')} WHEN c.reason='free_agent_checkin' THEN c.wake_context->>'checkinPrompt' ELSE m.text END text,CASE WHEN m.card_type='daemon-fact' AND m.card->>'type'='corner-complete' THEN m.card END merge_card,CASE WHEN workflow_latest.card IS NOT NULL THEN workflow_version.markdown::jsonb->'handoffs'->(workflow_latest.card->>'toState')->>'hint' WHEN m.room_id=c.room_id THEN COALESCE(m.card->>'receiptHint',choice_message.card->>'receiptHint') END receipt_hint,m.author_id,m.attachments,m.system_event,m.presentation,m.reply_to_message_id,reply_parent.author_id reply_to_author_id,reply_author.name reply_to_author_name,left(reply_parent.text,${REPLY_EXCERPT_MAX_LENGTH + 1}) reply_to_excerpt,CASE WHEN m.room_id=c.room_id AND m.card->>'runId' IS NOT NULL THEN m.card_type WHEN resume_source.room_id=c.room_id AND resume_source.card->>'runId' IS NOT NULL THEN resume_source.card_type WHEN m.room_id=c.room_id THEN m.card_type END wake_card_type,CASE WHEN m.room_id=c.room_id AND m.card->>'runId' IS NOT NULL THEN m.card WHEN resume_source.room_id=c.room_id AND resume_source.card->>'runId' IS NOT NULL THEN resume_source.card WHEN m.room_id=c.room_id THEN m.card END wake_card,workflow_latest.card->>'toState' workflow_state,NULLIF(workflow_start.card->>'runStatus','live') workflow_status,workflow_version.markdown::jsonb->'handoffs'->(workflow_latest.card->>'toState')->'on' workflow_outcomes,watched_corner.id watched_corner_id,watched_corner.name watched_corner_name,watched_fact.lifecycle->'pr'->>'mergeCommitSha' watched_merge_commit FROM agent_commands c LEFT JOIN messages m ON m.id=c.source_message_id LEFT JOIN rooms command_corner ON command_corner.id=c.room_id
 LEFT JOIN messages reply_parent ON reply_parent.id=m.reply_to_message_id
 LEFT JOIN identities reply_author ON reply_author.id=reply_parent.author_id
 LEFT JOIN rooms watched_corner ON watched_corner.id=m.room_id AND c.reason='watched_corner'
 LEFT JOIN corner_github_cache watched_fact ON watched_fact.corner_id=watched_corner.id
 LEFT JOIN agent_commands resume_parent ON resume_parent.id=c.parent_command_id AND c.action='resume'
 LEFT JOIN messages resume_source ON resume_source.id=resume_parent.source_message_id
 LEFT JOIN room_choices choice ON choice.id::text=m.card->>'choiceId' AND choice.room_id=c.room_id
 LEFT JOIN messages choice_message ON choice_message.id=choice.message_id
 LEFT JOIN LATERAL (
   SELECT latest.card FROM messages latest
   WHERE latest.room_id=c.room_id AND latest.card_type='workflow-handoff'
     AND latest.card->>'runId'=COALESCE(m.card->>'runId',choice_message.card->>'runId',resume_source.card->>'runId')
   ORDER BY (latest.card->>'seq')::int DESC NULLS LAST,latest.created_at DESC,latest.id DESC LIMIT 1
 ) workflow_latest ON true
 LEFT JOIN messages workflow_start ON workflow_start.id=workflow_latest.card->>'runId' AND workflow_start.room_id=c.room_id
 LEFT JOIN rooms workflow_room ON workflow_room.id=c.room_id
 LEFT JOIN workspace_skills workflow_skill ON workflow_skill.workspace_id=workflow_room.workspace_id
   AND workflow_skill.slug=workflow_latest.card->>'workflowSlug' AND workflow_skill.kind='workflow'
 LEFT JOIN workspace_skill_versions workflow_version ON workflow_version.skill_id=workflow_skill.id
   AND workflow_version.version=(workflow_latest.card->>'workflowVersion')::int
 WHERE c.room_id=$1 AND c.agent_id=$2
   AND CASE WHEN $3::text IS NULL THEN c.state='pending' ELSE c.state='claimed' AND c.generation_id=$3 END
   AND NOT EXISTS(SELECT 1 FROM cancelled_wakes cancelled WHERE cancelled.id=c.id)
   AND (${ordinaryWakeSql('c')} OR NOT EXISTS (
     SELECT 1 FROM agent_commands requested WHERE requested.room_id=c.room_id
       AND requested.agent_id=c.agent_id AND requested.reason<>'computer_activity'
       AND requested.action IN ('input','resume')
       AND (requested.state='pending' OR (requested.state='claimed' AND ${commandOwnerLiveSql('requested')}))
   ))
   AND workflow_latest.card->'cancellation' IS NULL
   AND ${reviewerQuietSql('c')} AND ${waitingReportSql('c')}
 ORDER BY CASE c.action WHEN 'stop' THEN 0 WHEN 'restart' THEN 1 WHEN 'resume' THEN 2 ELSE 3 END,CASE WHEN ${ordinaryWakeSql('c')} THEN 0 ELSE 1 END,c.created_at,c.id
     ) SELECT delivery.*,wake_drop_log.drops FROM wake_drop_log LEFT JOIN delivery ON true
     ORDER BY CASE delivery.action WHEN 'stop' THEN 0 WHEN 'restart' THEN 1 WHEN 'resume' THEN 2 ELSE 3 END,
       CASE WHEN ${ordinaryWakeSql('delivery')} THEN 0 ELSE 1 END,delivery.created_at,delivery.id`,
    [roomId, agentId, generation ?? null],
  );
  logStaleWakeDrops(rows.rows[0]?.drops);
  return {
    commandProtocol: 1,
    commands: rows.rows.filter(r => r.id).map((r) => ({
      id: r.id,
      roomId: r.room_id,
      agentId: r.agent_id,
      sourceMessageId: r.private_payload ? r.id : r.source_message_id ?? r.id,
      turnRequestId: r.turn_request_id,
      action: r.action,
      reason: r.reason,
      ...(r.private_payload ? { private: true } : {}),
      ...(r.delivered_context ? { recoveryContext: r.delivered_context } : {}),
      ...(r.system_event?.scheduleId ? { scheduleId: r.system_event.scheduleId } : {}),
      rootCommandId: r.root_command_id,
      ...(r.parent_command_id ? { parentCommandId: r.parent_command_id } : {}),
      rootSourceMessageId: r.root_source_message_id,
      agentDepth: r.agent_depth,
      source: {
        id: r.private_payload ? r.id : r.source_message_id ?? r.id,
        authorId: r.private_payload?.authorId ?? (r.reason === 'free_agent_checkin' ? SYSTEM_IDENTITY_ID : r.author_id),
        body: (r.private_payload?.text ?? (r.reason === 'watched_corner' ? `Watched corner ${r.watched_corner_name} (${r.watched_corner_id}): ${r.system_event?.kind}${r.system_event?.kind === 'merged' && r.watched_merge_commit ? ` · merge commit ${r.watched_merge_commit}` : ''}\n` : '') + subscriptionPromptBody(r.text, r.system_event ?? null)) + (r.voice_origin ? '\n' + voiceDateContext(Date.now()) + ' Never start your reply with your name.\nThis is a separate request from a live voice call. Answer this request in this turn, even if it appeared as background context while you were busy. Start your report with a spoken answer sized to the question: one line for a status, a few sentences for a real answer, at most about 150 words. Then a blank line, then the full report.' : '') + checkFailureLogBody(r.system_event ?? null) + reportedHeadBody(r.system_event ?? null) + mergeCardDetail(r.merge_card) + workflowWakeDetail(r.wake_card_type, r.wake_card, r.workflow_state, r.workflow_outcomes, r.workflow_status) + squireDecisionDetail(r.wake_card_type, r.wake_card) + (r.receipt_hint ? `\nReceipt hint for this state: ${r.receipt_hint}. Attach an optional receipt when you call handoff.` : ''),
        attachments: r.private_payload?.attachments ?? r.attachments ?? [],
        createdAt: Math.floor(r.created_at.getTime() / 1000),
        type: r.private_payload ? 'private' : r.reason === 'free_agent_checkin' ? 'system' : r.presentation,
        systemEvent: r.system_event,
        ...(r.reply_to_message_id ? { replyToMessageId: r.reply_to_message_id } : {}),
        ...(r.reply_to_author_id ? { replyToAuthorId: r.reply_to_author_id } : {}),
        ...(r.reply_to_author_name ? { replyToAuthorName: r.reply_to_author_name } : {}),
        ...(r.reply_to_excerpt !== null ? { replyToExcerpt: boundReplyExcerpt(r.reply_to_excerpt) } : {}),
      },
    })),
  };
}


/** Compatibility is a projection of durable commands, never a history query. */
export async function commandInbox(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
): Promise<RoomInboxResult> {
  const { commands } = await readAgentCommands(db, roomId, agentId);
  return {
    dispatchVersion: 1,
    items: commands.map((c) => ({
      ...c.source,
      id: c.sourceMessageId,
      ...(c.action === 'stop'
        ? {
            type: 'system',
            requestId: c.turnRequestId,
            systemEvent: {
              kind: 'turn-cancelled' as const,
              subject: { kind: 'agent' as const, id: agentId, name: agentId },
              verb: 'stopped',
            },
          }
        : {}),
    })),
  };
}


export async function routeSystemCommand(
  db: SqlDatabase,
  input: {
    roomId: string;
    sourceMessageId: string;
    kind?: string;
    targets: readonly string[];
    requestId?: string;
    causeId?: string;
    commandId?: string;
    followup?: boolean;
  },
): Promise<void> {
  if (!input.kind) return;
  // A checks verdict in a corner is a corner lifecycle event: the transition
  // decides who wakes, exactly once.
  if (input.kind === 'check-passed' || input.kind === 'check-failed') {
    const corner = await db.query(`SELECT 1 FROM corner_facts WHERE corner_id=$1`, [input.roomId]);
    if (corner.rowCount) {
      await advanceCorner(db, input.roomId, {
        kind: 'checks',
        result: input.kind === 'check-passed' ? 'passing' : 'failing',
        sourceMessageId: input.sourceMessageId,
        ...(input.followup ? { followup: true } : {}),
      });
      return;
    }
  }
  if (input.kind === 'computer-session-activity') {
    // Serialize producers per share. A claimed update stays immutable; all
    // further actions accumulate in a single pending update for that share.
    const activity = (await db.query<{ session_id: string; text: string }>(
      `SELECT session.id session_id,message.text FROM messages message
       JOIN computer_sessions session ON session.id=message.system_event->'payload'->>'sessionId'
       WHERE message.id=$1 AND session.room_id=$2 AND session.status='live'
       FOR UPDATE OF session`, [input.sourceMessageId, input.roomId],
    )).rows[0];
    if (!activity) return;
    for (const agentId of new Set(input.targets)) {
      const pending = (await db.query<CommandRow>(
        `SELECT command.* FROM agent_commands command
         JOIN messages source ON source.id=command.source_message_id
         WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
           AND command.reason='computer_activity'
           AND source.system_event->'payload'->>'sessionId'=$3
         FOR UPDATE OF command`, [input.roomId, agentId, activity.session_id],
      )).rows[0];
      if (pending) {
        await db.query(
          `UPDATE agent_commands SET source_message_id=$2,
             recovery_context=right(COALESCE(recovery_context || E'\\n','') || $3,16000)
           WHERE id=$1 AND state='pending'`, [pending.id, input.sourceMessageId, activity.text],
        );
      } else {
        const command = await createAgentCommand(db, {
          roomId: input.roomId, agentId, sourceMessageId: input.sourceMessageId, reason: 'computer_activity',
        });
        if (command) await db.query(`UPDATE agent_commands SET recovery_context=$2 WHERE id=$1`,
          [command.id, activity.text]);
      }
    }
    return;
  }
  // A Squire decision answers a turn that never paused: the agent posted the
  // approval link and either kept working or ended its turn. A live turn must
  // keep running (completing its command revokes its output authority and
  // drops it), so the resume waits behind it. Once that turn has ended, only
  // an approval starts the follow-up turn; a denial or expiry wakes nobody,
  // because the person who decided already knows and the agent has nothing
  // it can do with the answer.
  const squireDecision = input.kind === 'squire-approval-decided';
  const squireStatus = squireDecision
    ? (await db.query<{ status: string | null }>(
        `SELECT card->>'status' status FROM messages WHERE id=$1`, [input.sourceMessageId],
      )).rows[0]?.status
    : undefined;
  for (const agentId of new Set(input.targets)) {
    const action =
      input.kind === 'turn-cancelled' ? 'stop' : isResumeKind(input.kind) ? 'resume' : 'input';
    let parent: CommandRow | undefined;
    if (action !== 'input') {
      parent = (
        await db.query<CommandRow>(
          `SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action IN ('input','resume')
    AND (($3::text IS NOT NULL AND turn_request_id=$3) OR ($4::text IS NOT NULL AND id=$4)) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [input.roomId, agentId, input.requestId ?? null, input.commandId ?? null],
        )
      ).rows[0];
      if (!parent) continue;
      if (squireDecision && squireStatus !== 'approved' &&
          (parent.state === 'complete' || parent.state === 'cancelled'))
        continue;
      await db.query(
        `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,$4,NULL,NULL) ended FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3
           AND (state='pending' OR (state='claimed' AND NOT $5::boolean))) terminal`,
        [
          input.roomId,
          agentId,
          parent.turn_request_id,
          action === 'stop' ? 'cancelled' : 'complete',
          squireDecision,
        ],
      );
    } else if (input.kind.startsWith('agent:')) {
      parent = (
        await db.query<CommandRow>(
          `SELECT * FROM agent_commands WHERE room_id=$1 AND id=$2 AND state='claimed' ORDER BY created_at DESC LIMIT 1`,
          [input.roomId, input.commandId ?? null],
        )
      ).rows[0];
      if (!parent) continue;
    }
    await createAgentCommand(db, {
      roomId: input.roomId,
      agentId,
      sourceMessageId: input.sourceMessageId,
      action,
      reason:
        action === 'input'
          ? input.kind === 'schedule-ran'
            ? 'schedule'
            : 'subscribed_event'
          : action,
      ...(parent
        ? {
            parent,
            retainDepth: action !== 'input',
            turnRequestId: action !== 'input' ? parent.turn_request_id : undefined,
          }
        : {}),
    });
  }
}


/** A dirty current PR head is an actionable author turn, even with green CI. */
export async function queueCornerMergeConflict(
  db: SqlDatabase,
  cornerId: string,
  sourceMessageId: string,
): Promise<boolean> {
  const owner = (
    await db.query<{ owner_agent_id: string }>(
      `SELECT ${cornerImplementerSql('fact', 'corner')} owner_agent_id FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       WHERE fact.corner_id=$1 AND corner.archived_at IS NULL
         AND ${cornerLifecycleSql('fact.corner_id')}->'pr'->>'mergeability'='dirty'`,
      [cornerId],
    )
  ).rows[0]?.owner_agent_id;
  if (!owner) return false;
  const command = await createAgentCommand(db, {
    roomId: cornerId,
    agentId: owner,
    sourceMessageId,
    reason: 'corner_merge_conflict',
  });
  return Boolean(command);
}


/** Recover blocker lifecycles whose note or command was lost before delivery. */
export async function reconcileCornerMergeBlockers(
  db: SqlDatabase,
  cornerId?: string,
): Promise<number> {
  const stranded = await db.query<{
    corner_id: string;
    owner_agent_id: string;
    checks: string;
    mergeability: string;
    head_sha: string;
    number: number;
    title: string;
    url: string;
  }>(
    `SELECT fact.corner_id,${cornerImplementerSql('fact', 'corner')} owner_agent_id,
            gh.lifecycle->>'checks' checks,
            gh.lifecycle->'pr'->>'mergeability' mergeability,
            gh.lifecycle->'pr'->>'headSha' head_sha,
            (gh.lifecycle->'pr'->>'number')::integer number,
            gh.lifecycle->'pr'->>'title' title,
            gh.lifecycle->'pr'->>'url' url
     FROM (corner_facts fact JOIN corner_github_cache gh ON gh.corner_id=fact.corner_id) JOIN rooms corner ON corner.id=fact.corner_id
     WHERE corner.archived_at IS NULL AND ${cornerImplementerSql('fact', 'corner')} IS NOT NULL
       AND ($1::uuid IS NULL OR fact.corner_id=$1)
       AND gh.lifecycle->'pr'->>'headSha' IS NOT NULL
       AND gh.lifecycle->'pr'->>'number' ~ '^[0-9]+$'
       AND (gh.lifecycle->>'checks'='failing'
            OR gh.lifecycle->'pr'->>'mergeability'='dirty'
            OR (gh.lifecycle->'pr'->>'mergeability'='draft'
              AND gh.lifecycle->'draftReadyFailure'->>'headSha'=gh.lifecycle->'pr'->>'headSha'))`,
    [cornerId ?? null],
  );
  let commands = 0;
  for (const row of stranded.rows) {
    commands += await db.transaction(async (db) => {
      await lockCornerLifecycle(db, row.corner_id);
      let routedCommands = 0;
      // A known-red head wakes the implementer even while other checks are
      // still running. A wake already recorded for this head is left in place.
      if (row.checks === 'failing') {
        const existing = await db.query(
          `SELECT 1 FROM agent_commands command
           JOIN messages source ON source.id=command.source_message_id
           WHERE command.room_id=$1 AND command.agent_id=$2
             AND command.reason='corner_check'
             AND source.system_event->'object'->>'headSha'=$3 LIMIT 1`,
          [row.corner_id, row.owner_agent_id, row.head_sha],
        );
        if (!existing.rowCount) {
          const source = await systemLine(db, {
            id: createHash('sha256')
              .update(`beeline:${row.corner_id}:github:checks-failed:${row.head_sha}`)
              .digest('hex'),
            roomId: row.corner_id,
            authorId: row.owner_agent_id,
            subject: GITHUB_SUBJECT,
            verb: systemMessage("agent-command.found-failing-checks-on"),
            kind: 'check-failed',
            object: {
              text: row.title ?? systemMessage("agent-command.pull-request", row.number),
              url: row.url,
              headSha: row.head_sha,
            },
          });
          if (!source.inserted) {
            await routeSystemCommand(db, {
              roomId: row.corner_id,
              sourceMessageId: source.id,
              kind: 'check-failed',
              targets: [],
            });
          }
          const routed = await db.query(
            `SELECT 1 FROM agent_commands WHERE room_id=$1 AND source_message_id=$2 AND agent_id=$3`,
            [row.corner_id, source.id, row.owner_agent_id],
          );
          if (routed.rowCount) routedCommands += 1;
        }
      }
      if (row.mergeability === 'draft' && row.checks === 'passing') {
        const current = await db.query(`SELECT 1 FROM corner_github_cache fact JOIN rooms corner ON corner.id=fact.corner_id
          WHERE fact.corner_id=$1 AND corner.archived_at IS NULL
            AND fact.lifecycle->'pr'->>'headSha'=$2
            AND fact.lifecycle->'draftReadyFailure'->>'headSha'=$2
            AND fact.lifecycle->'pr'->>'mergeability'='draft' AND fact.lifecycle->>'checks'='passing'`,
          [row.corner_id, row.head_sha]);
        if (!current.rowCount) return routedCommands;
        const gate = await cornerMergeGate(db, row.corner_id, { number: row.number, headSha: row.head_sha });
        if (gate.open) await reportToCommander(db, row.corner_id, row.owner_agent_id,
          systemMessage("agent-command.blocked-pr-is-a-draft-marking-it-ready-for-review-failed"), undefined,
          createHash('sha256').update(`draft-blocked:${row.corner_id}:${row.head_sha}`).digest('hex'));
      }
      if (row.mergeability === 'dirty') {
        // Keyed on the head only, matching mergeConflictKey: a moved base must
        // not turn one stale 'dirty' verdict into a fresh wake.
        const generation = `${row.number}:${row.head_sha}`;
        const id = createHash('sha256')
          .update(`beeline:${row.corner_id}:github:merge-conflict:${generation}`)
          .digest('hex');
        const exists = await db.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1 AND source_message_id=$2 AND agent_id=$3`,
          [row.corner_id, id, row.owner_agent_id],
        );
        if (exists.rowCount) return routedCommands;
        const note = await systemLine(db, {
          id,
          roomId: row.corner_id,
          authorId: row.owner_agent_id,
          subject: GITHUB_SUBJECT,
          verb: systemMessage("agent-command.found-merge-conflicts-in"),
          object: {
            text: row.title ?? systemMessage("agent-command.pull-request", row.number),
            url: row.url,
            headSha: row.head_sha,
          },
        });
        if (await queueCornerMergeConflict(db, row.corner_id, note.id)) routedCommands += 1;
      }
      return routedCommands;
    });
  }
  return commands;
}
