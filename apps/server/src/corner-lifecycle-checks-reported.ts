import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { REVIEW_VERDICT_SQL } from './review-evidence.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { cornerReportWaiting } from './corner-state.js';
import { reportToCommander } from './commander.js';
import type { activeCornerHolds } from './corner-holds.js';
import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { createAgentCommand, refuseVerdictedReviewerWake, repairReviewerCornerMembership, type CommandRow } from './agent-command.js';
import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import { CornerRow, Transition, CornerEvent, Applied, no, ChecksPlan, OK, RevisionWake } from './corner-lifecycle.js';
import { cornerMergeGate } from './corner-lifecycle-corner-merge-gate.js';



export async function checksReported(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Extract<CornerEvent, { kind: 'checks' }>,
): Promise<Applied> {
  // Read the durable event under the lifecycle lock, before either verdict can wake anyone.
  const source = (await db.query<{ head_sha: string | null }>(
    `SELECT system_event->'object'->>'headSha' head_sha FROM messages WHERE id=$1 AND room_id=$2`,
    [event.sourceMessageId, cornerId],
  )).rows[0];
  if (source?.head_sha && source.head_sha !== corner.lifecycle.pr?.headSha)
    return no('checks event belongs to an old head');
  // A fact replayed after the checks moved on is stale.
  if (corner.lifecycle.checks !== event.result) return no(`checks are ${corner.lifecycle.checks}`);
  const from = transition.state;
  if (!['checks', 'implement', 'review', 'ask_human'].includes(from)) return no('no checks edge');
  const headSha = corner.lifecycle.pr?.headSha ?? null;
  const sameHead = transition.run.headSha === (headSha ?? undefined);
  // A repeat of the green verdict that already holds changes nothing, and
  // must not spend a reviewer pick, a membership repair, or a note. A head
  // waiting for a person's yes is re-planned: a reviewer configured since
  // then is woken.
  if (event.result === 'passing' && from === 'review' && sameHead && transition.run.outcome !== 'no_reviewer')
    return ensureReviewDispatch(db, cornerId, corner, transition);
  let plan: ChecksPlan;
  if (event.result === 'failing') plan = { outcome: 'failing' };
  // A yes given while checks ran (a PASS or a person's order) needs no review.
  else if (await approvedCurrentHead(db, cornerId, corner)) plan = { outcome: 'passing', approved: true };
  else if (!independentReviewerConfigured(corner)) plan = { outcome: 'no_reviewer' };
  else {
    const reviewerAgentId = await reachableReviewer(db, cornerId, corner, event.sourceMessageId);
    if (!reviewerAgentId)
      return noteReviewBlocked(db, cornerId, corner, headSha ?? event.sourceMessageId,
        systemMessage("corner-lifecycle.the-configured-reviewer-is-unreachable-or-unhealthy"), false);
    plan = { outcome: 'passing', approved: false, reviewerAgentId };
  }
  if (from === 'review' && sameHead && plan.outcome === 'no_reviewer')
    return ensureReviewDispatch(db, cornerId, corner, transition);
  if (from === 'implement' && sameHead) {
    const repeat = transition.run.outcome === plan.outcome;
    if (repeat && plan.outcome === 'failing' && event.followup) {
      if (!corner.worker_agent_id) {
        await noteReviewDispatchFailure(db, cornerId, headSha ?? event.sourceMessageId, systemMessage("corner-lifecycle.the-corner-has-no-implementer"));
        return no('the corner has no implementer');
      }
      const command = await createAgentCommand(db, {
        roomId: cornerId, agentId: corner.worker_agent_id,
        sourceMessageId: event.sourceMessageId, reason: 'corner_check',
      });
      return command ? OK : no('the implementer cannot be woken');
    }
    if (repeat) return no(`${plan.outcome} already holds on this head`);
  }
  // The wake goes out first: a verdict whose wake cannot be delivered (the
  // implementer is no longer a member) leaves the run in place, so the next
  // report of the same verdict retries it.
  if (plan.outcome === 'failing') {
    if (!corner.worker_agent_id) {
      await noteReviewDispatchFailure(db, cornerId, headSha ?? event.sourceMessageId, systemMessage("corner-lifecycle.the-corner-has-no-implementer"));
      return no('the corner has no implementer');
    }
    const command = await createAgentCommand(db, {
      roomId: cornerId,
      agentId: corner.worker_agent_id,
      sourceMessageId: event.sourceMessageId,
      reason: 'corner_check',
    });
    if (!command) {
      return no('the implementer cannot be woken');
    }
  } else if (plan.outcome === 'passing' && !plan.approved && !(await blockingReview(db, cornerId, headSha))) {
    // A blocking verdict on this head is handed back by
    // `ensureReviewDispatch` instead of waking the reviewer again.
    const queued = await queueReviewerCommand(db, {
      roomId: cornerId,
      agentId: plan.reviewerAgentId,
      sourceMessageId: event.sourceMessageId,
      reason: 'subscribed_event',
    });
    if (!queued.command && !queued.blocked) {
      const reason = systemMessage("corner-lifecycle.the-reviewer-command-could-not-be-queued-on-restore-reviewer-acce", headSha ?? systemMessage("corner-lifecycle.this-head"), queued.error ? systemMessage("corner-lifecycle.dispatch-error", queued.error) : '');
      console.error(`[corner-lifecycle] ${cornerId}: ${reason}`);
      return noteReviewBlocked(db, cornerId, corner, headSha ?? event.sourceMessageId, reason);
    }
  }
  if (from !== 'checks') await transition.take(systemMessage("corner-lifecycle.rechecked"));
  await transition.take(plan.outcome, headSha ? { headSha } : {});
  if (plan.outcome === 'no_reviewer') {
    return noteMissingReviewer(db, cornerId, corner, headSha ?? event.sourceMessageId);
  }
  if (plan.outcome === 'passing' && plan.approved) {
    await transition.take(systemMessage("corner-lifecycle.approved"), { verdict: 'approved' });
    await wakeToLand(db, cornerId, corner, transition);
  }
  return OK;
}


/** Zero checks need the commander's yes; other review gaps retain their handback. */
export async function noteMissingReviewer(db: SqlDatabase, cornerId: string, corner: CornerRow, headKey: string): Promise<Applied> {
  if (corner.lifecycle.checksSummary?.total === 0) {
    const command = corner.worker_agent_id ? await createAgentCommand(db, {
      id: createHash('sha256').update(`zero-check-ready:${cornerId}:${headKey}`).digest('hex'),
      roomId: cornerId, agentId: corner.worker_agent_id, sourceMessageId: null,
      privatePayload: { text: 'This pull request has no checks and no reviewer. Landing needs your commander\'s yes. Ask your commander using your normal report tool.',
        authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId, kind: 'lifecycle' },
      reason: 'corner_review_needed',
    }) : undefined;
    return { ok: true, wake: command ? { queued: true, agentId: corner.worker_agent_id! }
      : { queued: false, reason: 'The implementer cannot be woken to ask its commander for a merge decision' } };
  }
  return noteReviewBlocked(db, cornerId, corner, headKey, systemMessage("corner-lifecycle.no-reviewer-is-configured"));
}


/**
 * One handback for every review gap. The implementer owns arranging another
 * review or reporting the blocker up the chain; a passive transcript note
 * alone cannot make that happen. A stable episode key dedupes fact replays.
 */
export async function noteReviewBlocked(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headKey: string,
  reason: string,
  reportCommander = true,
): Promise<Applied> {
  const episode = `${cornerId}:${headKey}:${reason}`;
  if (reportCommander) await reportToCommander(db, cornerId, SYSTEM_IDENTITY_ID, systemMessage("corner-lifecycle.blocked", reason),
    undefined, createHash('sha256').update(`review-gap:${episode}`).digest('hex'));
  const command = corner.worker_agent_id ? await createAgentCommand(db, {
    id: createHash('sha256').update(`review-needed:${episode}`).digest('hex'),
    roomId: cornerId, agentId: corner.worker_agent_id, sourceMessageId: null,
    privatePayload: { text: `Checks passed; ${reason}; arrange review or report the blocker to its commander`,
      authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId, kind: 'lifecycle' },
    reason: 'corner_review_needed',
  }) : undefined;
  const wakeResult = command ? { queued: true, agentId: corner.worker_agent_id! }
    : { queued: false, reason: systemMessage("corner-lifecycle.the-implementer-cannot-be-woken-to-arrange-review") };
  if (!command) await noteReviewDispatchFailure(db, cornerId, headKey, wakeResult.reason!);
  return { ok: true, wake: wakeResult };
}


export async function noteReviewDispatchFailure(
  db: SqlDatabase, cornerId: string, headSha: string, reason: string,
): Promise<void> {
  await reportToCommander(db, cornerId, SYSTEM_IDENTITY_ID, systemMessage("corner-lifecycle.blocked", reason),
    undefined, createHash('sha256').update(`review-dispatch:${cornerId}:${headSha}:${reason}`).digest('hex'));
}


/**
 * Repair a green review state whose reviewer wake is missing or failed. Any
 * active reviewer command since the run's newest card counts. A completed
 * verdict without PASS returns findings to the implementer. A completion
 * without a verdict is reported once; it never creates another review turn.
 * A report filed while the gate was still pending is not that review, so it
 * does not swallow the one wake for this head.
 */
export async function ensureReviewDispatch(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
): Promise<Applied> {
  const pr = corner.lifecycle.pr;
  if (transition.state !== 'review' || corner.lifecycle.checks !== 'passing' || !pr?.headSha)
    return OK;
  if (transition.run.headSha !== pr.headSha || await approvedCurrentHead(db, cornerId, corner))
    return OK;
  if (!independentReviewerConfigured(corner)) return noteMissingReviewer(db, cornerId, corner, pr.headSha);
  const outstanding = await db.query<{ id: string; state: string }>(
    `SELECT command.id,command.state FROM agent_commands command
     JOIN rooms corner ON corner.id=command.room_id
     JOIN rooms parent ON parent.id=corner.parent_id
     WHERE command.room_id=$1 AND command.action='input'
       AND command.agent_id=${cornerReviewerSql()}
       AND command.agent_id IS DISTINCT FROM $3
       AND command.state IN ('pending','claimed')
       AND ((command.review_context->>'headSha'=(SELECT lifecycle->'pr'->>'headSha' FROM corner_github_cache WHERE corner_id=$1)
           AND command.review_context->'pullRequest'=(SELECT lifecycle->'pr'->'number' FROM corner_github_cache WHERE corner_id=$1)
           AND (command.review_context->>'briefRevision')::int=COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$1),0))
         OR (command.review_context IS NULL AND command.created_at>=(
           SELECT created_at FROM messages WHERE room_id=$1 AND card_type=$2
             AND card->>'runId'=$1::text ORDER BY (card->>'seq')::int DESC LIMIT 1)))
     ORDER BY (command.state IN ('pending','claimed')) DESC,command.created_at DESC,command.id DESC
     LIMIT 1`,
    [cornerId, CORNER_LIFECYCLE_CARD_TYPE, corner.worker_agent_id],
  );
  const reviewed = outstanding.rows[0];
  if (reviewed?.state === 'pending' || reviewed?.state === 'claimed') return OK;
  const ended = await blockingReview(db, cornerId, pr.headSha);
  if (ended) {
    const implementerWorking = await db.query(
      `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2
       AND action='input' AND state IN ('pending','claimed') LIMIT 1`,
      [cornerId, corner.worker_agent_id],
    );
    if (implementerWorking.rowCount) return OK;
    const evidence = (await db.query<{ text: string }>(
      `SELECT result.text FROM agent_commands command JOIN messages result ON result.id=command.result_message_id
       WHERE command.id=$1`, [ended],
    )).rows[0]?.text;
    const reason = systemMessage("corner-lifecycle.the-reviewer-completed-its-review-of-the-current-head", evidence ? systemMessage("corner-lifecycle.prior-verdict-and-evidence", evidence) : '');
    // A consumed handback already delivered these findings. In particular,
    // an implementer's explicit wait must not turn that delivery into a wake
    // failure, whose report can send the same target back to the reviewer
    // that ordered the repair.
    const handbackId = createHash('sha256').update(`review-needed:${cornerId}:${pr.headSha}:${ended}:${reason}`).digest('hex');
    if ((await db.query('SELECT 1 FROM agent_commands WHERE id=$1', [handbackId])).rowCount ||
        await cornerReportWaiting(db, cornerId)) return OK;
    return noteReviewBlocked(db, cornerId, corner, `${pr.headSha}:${ended}`,
      reason, false);
  }
  const completedReview = (await db.query<{failed:boolean;implementer_working:boolean}>(`SELECT EXISTS(
      SELECT 1 FROM agent_turns turn WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
        AND turn.request_id=command.turn_request_id AND turn.generation_id=command.generation_id
        AND turn.status='failed') failed, EXISTS(SELECT 1 FROM agent_commands worker
      WHERE worker.room_id=$1 AND worker.agent_id=$4 AND worker.action='input'
        AND worker.state IN ('pending','claimed')) implementer_working
    FROM agent_commands command WHERE room_id=$1
    AND review_context->>'headSha'=$2 AND review_context->>'purpose' IS NULL
    AND review_context->'pullRequest'=$3::jsonb AND action='input' AND state='complete'
    ORDER BY completed_at DESC LIMIT 1`, [cornerId,pr.headSha,JSON.stringify(pr.number),corner.worker_agent_id])).rows[0];
  if (completedReview) return completedReview.failed || completedReview.implementer_working ? OK : noteMissingReviewVerdict(db, cornerId, corner, pr.headSha);
  const sourceId = transition.lastCardId ?? (
    await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1 AND card_type=$2
       AND card->>'runId'=$1::text ORDER BY (card->>'seq')::int DESC LIMIT 1`,
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
    )
  ).rows[0]?.id;
  if (!sourceId) throw new Error(`green review ${cornerId} has no lifecycle card for dispatch`);
  const reviewerAgentId = await reachableReviewer(db, cornerId, corner, sourceId);
  if (!reviewerAgentId) {
    console.error(`[corner-lifecycle] ${cornerId}: green review reviewer is unreachable or unhealthy; reporting to the commander`);
    return noteReviewBlocked(db, cornerId, corner, pr.headSha,
      systemMessage("corner-lifecycle.the-configured-reviewer-is-unreachable-or-unhealthy"), false);
  }
  // A fresh source lets a recovered review wake follow an earlier completed
  // command from the same check fact. The lifecycle card remains the run state.
  const source = await systemLine(db, {
    roomId: cornerId,
    authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
    subject: GITHUB_SUBJECT,
    verb: systemMessage("corner-lifecycle.requested-review-of"),
    object: { text: pr.title ?? systemMessage("corner-lifecycle.pull-request", pr.number), ...(pr.url ? { url: pr.url } : {}), headSha: pr.headSha },
  });
  const queued = await queueReviewerCommand(db, {
    roomId: cornerId,
    agentId: reviewerAgentId,
    sourceMessageId: source.id,
    reason: 'corner_review_dispatch',
  });
  if (!queued.command && !queued.blocked) {
    const reason = systemMessage("corner-lifecycle.the-reviewer-command-could-not-be-queued-on-restore-reviewer-acce", pr.headSha, queued.error ? systemMessage("corner-lifecycle.dispatch-error", queued.error) : '');
    console.error(`[corner-lifecycle] ${cornerId}: ${reason}`);
    return noteReviewBlocked(db, cornerId, corner, pr.headSha, reason);
  }
  return { ok: true, wake: { queued: true, agentId: reviewerAgentId } };
}


// Compare check results, not refresh timestamps, attempts or run URLs.
export const reviewChecksSql = `jsonb_build_object('status',lifecycle->>'checks','checks',
  (SELECT jsonb_agg(jsonb_build_object('name',item->>'name','status',item->>'status') ORDER BY item->>'name')
   FROM jsonb_array_elements(COALESCE(lifecycle->'checksSummary'->'checks','[]'::jsonb)) item))`;


/** Exhausted empty reviews are a private missing-verdict handback, never a completed review. */
export async function noteMissingReviewVerdict(db: SqlDatabase, cornerId: string, corner: CornerRow, headSha: string): Promise<Applied> {
  const text = 'blocked: the reviewer ended without a verdict after bounded retries; arrange review or restore reviewer access';
  await reportToCommander(db, cornerId, SYSTEM_IDENTITY_ID, text, undefined,
    createHash('sha256').update(`review-no-verdict:${cornerId}:${headSha}`).digest('hex'),
    {automatic: true, agentOnly: true});
  const command = corner.worker_agent_id ? await createAgentCommand(db, {
    id: createHash('sha256').update(`review-no-verdict-worker:${cornerId}:${headSha}`).digest('hex'),
    roomId: cornerId, agentId: corner.worker_agent_id, sourceMessageId: null,
    privatePayload: {text, authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId, kind: 'lifecycle'},
    reason: 'corner_review_needed',
  }) : undefined;
  return {ok: true, wake: {queued: Boolean(command), ...(command ? {agentId: corner.worker_agent_id!} : {})}};
}


/**
 * The reviewer's finished review of this head (callers have already checked
 * for an approval on the head), while the corner was still in review. Another
 * review wake for the same head would only repeat that verdict. A later brief
 * revision does not reopen it: the code is unchanged. A new head does.
 * Delivered failed/blocked reports retain their head even if checks changed
 * during the turn; a failed execution without a delivered decision does not.
 */
export async function blockingReview(
  db: SqlDatabase,
  cornerId: string,
  headSha: string | null,
): Promise<string | undefined> {
  if (!headSha) return undefined;
  return (
    await db.query<{ id: string }>(
      `SELECT command.id FROM agent_commands command
       JOIN rooms corner ON corner.id=command.room_id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN messages source ON source.id=command.source_message_id
       JOIN agent_turns turn ON turn.room_id=command.room_id
         AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
       LEFT JOIN LATERAL (SELECT true delivered FROM agent_commands repair
         WHERE repair.room_id=command.room_id AND repair.parent_command_id=command.id AND repair.reason='order'
           AND repair.private_payload->>'authorId'=command.agent_id
           AND repair.review_context->>'purpose'='repair'
           AND repair.review_context->>'headSha'=$2
           AND repair.review_context->'pullRequest'=command.review_context->'pullRequest'
           AND repair.private_payload->>'text' ~* $4 LIMIT 1) repair_verdict ON true
       WHERE command.room_id=$1 AND command.action='input'
         AND (command.state='complete' AND turn.status='complete'
           OR COALESCE(command.private_payload->>'reportedOutcome',command.report_outcome) IN ('failed','blocked') OR repair_verdict.delivered)
         AND (EXISTS (SELECT 1 FROM messages verdict
           WHERE verdict.room_id=command.room_id AND verdict.author_id=command.agent_id
             AND (verdict.id=command.result_message_id OR verdict.request_id=command.turn_request_id
               OR verdict.id IN (SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb))))
             AND verdict.deleted_at IS NULL AND verdict.text ~* $4)
           OR EXISTS (SELECT 1 FROM agent_commands report
             WHERE report.id IN (SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb)))
               AND report.private_payload->>'authorId'=command.agent_id AND report.private_payload->>'text' ~* $4)
           OR repair_verdict.delivered)
         AND command.agent_id=${cornerReviewerSql()}
         AND (command.reason='corner_review_dispatch'
           OR (command.reason IN ('agent_tag','order') AND command.review_context IS NOT NULL
             AND command.review_context->>'purpose' IS DISTINCT FROM 'repair')
           OR (command.reason='subscribed_event' AND source.system_event->>'kind'='check-passed'))
         AND COALESCE(command.review_context->>'headSha',source.system_event->'object'->>'headSha',
           (SELECT COALESCE(card->'contents'->>'headSha',card->>'headSha') FROM messages
            WHERE room_id=$1 AND card_type=$3 AND card->>'runId'=$1::text AND created_at<=command.created_at
            ORDER BY (card->>'seq')::int DESC LIMIT 1))=$2
         AND (command.review_context IS NULL OR command.review_context->'pullRequest'=(
           SELECT lifecycle->'pr'->'number' FROM corner_github_cache WHERE corner_id=$1))
         AND (COALESCE(command.private_payload->>'reportedOutcome',command.report_outcome) IN ('failed','blocked') OR repair_verdict.delivered OR NOT EXISTS (
           SELECT 1 FROM messages card WHERE card.room_id=$1 AND card.card_type=$3
             AND card.card->>'runId'=$1::text AND card.card->>'fromState'='review'
             AND card.created_at>command.created_at
             AND card.created_at<=COALESCE(command.completed_at,now())))
       ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
      [cornerId, headSha, CORNER_LIFECYCLE_CARD_TYPE, `${REVIEW_VERDICT_SQL}|(^|\\n)[[:space:]]*blocked:[[:space:]]*[^[:space:]]`],
    )
  ).rows[0]?.id;
}


export async function queueReviewerCommand(
  db: SqlDatabase,
  input: Parameters<typeof createAgentCommand>[1],
): Promise<{ command?: CommandRow; error?: string; blocked?: boolean }> {
  // The wake names the brief revision current at dispatch, so a reviewer
  // never reviews against a superseded one.
  const brief = (
    await db.query<{ revision: number }>(
      `SELECT revision FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
      [input.roomId],
    )
  ).rows[0];
  const context = (await db.query<{ context: Record<string, unknown> | null }>(
    `SELECT CASE WHEN lifecycle->'pr'->>'headSha' IS NOT NULL AND lifecycle->'pr'->>'number' IS NOT NULL
       THEN jsonb_build_object('cornerId',corner_id,'headSha',lifecycle->'pr'->>'headSha',
       'pullRequest',lifecycle->'pr'->'number','briefRevision',$2::int,
       'checks',${reviewChecksSql}) ELSE NULL END context
     FROM corner_github_cache WHERE corner_id=$1`, [input.roomId, brief?.revision ?? 0],
  )).rows[0]?.context;
  const headSha = typeof context?.headSha === 'string' ? context.headSha : undefined;
  const rawPull = context?.pullRequest;
  const pullRequest = typeof rawPull === 'number' ? rawPull
    : typeof rawPull === 'string' && /^\d+$/.test(rawPull) ? Number(rawPull) : null;
  if (headSha !== undefined && await refuseVerdictedReviewerWake(db, input.roomId, input.agentId, headSha, pullRequest))
    return { blocked: true };
  const prior = (await db.query<{ text: string }>(
    `SELECT result.text FROM agent_commands command JOIN messages result ON result.id=command.result_message_id
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.review_context IS NOT NULL
       AND command.state='complete' ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
    [input.roomId, input.agentId],
  )).rows[0]?.text;
  // A rejected insert must leave this transaction usable so the failure line
  // can commit. A broken connection still propagates rather than pretending
  // the reviewer was woken.
  await db.query('SAVEPOINT corner_reviewer_dispatch');
  try {
    const command = await createAgentCommand(db, {
      ...input,
      wakeNote: [context ? `Current handoff target: PR #${context.pullRequest} at ${context.headSha}. Older heads in the conversation are historical.` : '',
        brief ? `Review against brief revision ${brief.revision}, the corner's current brief at this dispatch.` : '',
        prior ? `Prior reviewer verdict and evidence (historical context):\n${prior}` : ''].filter(Boolean).join('\n'),
    });
    if (command) await db.query('UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1',
      [command.id, context ? JSON.stringify(context) : null]);
    if (command) command.review_context = context as Record<string, unknown> | null;
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return { command };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT corner_reviewer_dispatch');
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return { error: error instanceof Error ? error.message.slice(0, 160) : systemMessage("corner-lifecycle.unknown-dispatch-error") };
  }
}


/** A reviewer is configured and is not the implementer it would review. */
export function independentReviewerConfigured(corner: CornerRow): boolean {
  return Boolean(corner.configured_reviewer_id) && corner.configured_reviewer_id !== corner.worker_agent_id;
}


/**
 * Which reviewer a green head wakes, or undefined (after naming the gap in the
 * corner) when the configured reviewer cannot be reached. A configured
 * reviewer who is not a current member is never "no reviewer": it does not
 * fall through to the no-reviewer path.
 */
export async function reachableReviewer(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  sourceMessageId: string,
): Promise<string | undefined> {
  const reviewerId = corner.configured_reviewer_id;
  if (!reviewerId || reviewerId === corner.worker_agent_id) return undefined;
  if (!corner.reviewer_parent_member) {
    await noteUnreachableReviewer(db, {
      cornerId,
      sourceMessageId,
      reviewerId,
      reviewerKind: corner.configured_reviewer_kind,
      reviewerName: corner.configured_reviewer_name,
      reason: REVIEWER_NOT_PARENT_MEMBER,
    });
    return undefined;
  }
  return (await readableByReviewer(db, cornerId, reviewerId, sourceMessageId)) ? reviewerId : undefined;
}


/**
 * Dispatch only when the reviewer can read the corner; a missing projection
 * is repaired, an unreachable reviewer is named instead of rerouting the
 * review to the owner (whose daemon would post it under the owner's name).
 */
export async function readableByReviewer(
  db: SqlDatabase,
  cornerId: string,
  reviewerAgentId: string,
  sourceMessageId: string,
): Promise<boolean> {
  if (await repairReviewerCornerMembership(db, cornerId, reviewerAgentId)) return true;
  const reviewer = (
    await db.query<{ kind: string; name: string }>(`SELECT kind,name FROM identities WHERE id=$1`, [
      reviewerAgentId,
    ])
  ).rows[0];
  await noteUnreachableReviewer(db, {
    cornerId,
    sourceMessageId,
    reviewerId: reviewerAgentId,
    reviewerKind: reviewer?.kind ?? null,
    reviewerName: reviewer?.name ?? null,
    reason: REVIEWER_NOT_CORNER_MEMBER,
  });
  return false;
}


export async function approvalRecorded(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Extract<CornerEvent, { kind: 'approval' }>,
): Promise<Applied> {
  if (corner.lifecycle.pr?.headSha !== event.headSha) return no('approval is not for the current head');
  // A yes while checks still run is kept; the checks-passed that follows it
  // skips the review.
  if (corner.lifecycle.checks !== 'passing') return no('checks are not green yet');
  if (transition.state !== 'review') return no('not waiting for a yes');
  await transition.take(systemMessage("corner-lifecycle.approved"), { verdict: 'approved', headSha: event.headSha });
  // A reviewer's PASS and a person's order are landed by their callers at once.
  return OK;
}


/** A yes given while checks ran hands the merge to the implementer (`merge_corner`) once they pass. */
export async function wakeToLand(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
): Promise<void> {
  if (corner.worker_agent_id && transition.lastCardId)
    await wake(db, cornerId, corner.worker_agent_id, transition.lastCardId, 'corner_land');
}


export async function mergeRefused(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Extract<CornerEvent, { kind: 'merge-refused' }>,
): Promise<Applied> {
  if (corner.lifecycle.pr?.headSha !== event.headSha) return no('the head moved');
  if (!transition.allows('merge_refused')) return no('not landing');
  await transition.take(systemMessage("corner-lifecycle.merge-refused"), { headSha: event.headSha, reason: event.reason });
  const pullRequest = corner.lifecycle.pr;
  const line = await systemLine(db, {
    // Confirmed refusals can recur on one head; each needs its own wake source.
    // Deduplicate refusals whose outcome GitHub could not yet confirm.
    id: event.confirmedUnmerged ? undefined : createHash('sha256')
      .update(`beeline:${cornerId}:github:merge-refused:${event.headSha}`)
      .digest('hex'),
    roomId: cornerId,
    authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
    subject: GITHUB_SUBJECT,
    verb: systemMessage("corner-lifecycle.refused-to-merge"),
    object: {
      text: pullRequest?.title ?? systemMessage("corner-lifecycle.pull-request", pullRequest?.number ?? ''),
      ...(pullRequest?.url ? { url: pullRequest.url } : {}),
      headSha: event.headSha,
    },
    consequence: event.reason,
  });
  if (corner.worker_agent_id)
    await wake(db, cornerId, corner.worker_agent_id, line.id, 'corner_merge_refused');
  return OK;
}


export async function wake(
  db: SqlDatabase,
  cornerId: string,
  agentId: string,
  sourceMessageId: string,
  reason: string,
): Promise<RevisionWake> {
  if (await cornerReportWaiting(db, cornerId)) return { queued: false, reason: 'The corner is waiting for an answer' };
  const command = await createAgentCommand(db, { roomId: cornerId, agentId, sourceMessageId, reason });
  return command ? { queued: true, agentId } : { queued: false, reason: 'The implementer cannot be woken' };
}


export const REVIEWER_NOT_PARENT_MEMBER = 'not a current member of the parent Room';

export const REVIEWER_NOT_CORNER_MEMBER = 'not a current member of this corner';


/**
 * A configured reviewer that cannot be dispatched is named in the corner, not
 * collapsed into the no-reviewer path. Deterministic id so a later retry of
 * the same gap does not spam.
 */
export async function noteUnreachableReviewer(
  db: SqlDatabase,
  input: {
    cornerId: string;
    sourceMessageId: string;
    reviewerId: string;
    reviewerKind: string | null;
    reviewerName: string | null;
    reason: string;
  },
): Promise<void> {
  console.error(`[corner-lifecycle] ${input.cornerId}: reviewer ${input.reviewerId} ${input.reason}; reporting to the commander`);
  const id = createHash('sha256')
    .update(`beeline:${input.cornerId}:reviewer-unreachable:${input.reviewerId}:${input.reason}`)
    .digest('hex');
  await reportToCommander(db, input.cornerId, input.reviewerId,
    systemMessage("corner-lifecycle.blocked-configured-reviewer-could-not-be-reached", input.reviewerName ?? input.reviewerId, input.reason),
    undefined, id);
}


/** A yes on the corner's current head (`cornerMergeGate`'s `approved`). */
export async function approvedCurrentHead(
  db: SqlDatabase,
  cornerId: string,
  corner: Pick<CornerRow, 'lifecycle'>,
): Promise<boolean> {
  const pr = corner.lifecycle.pr;
  if (!pr?.headSha || !pr.number) return false;
  return (await cornerMergeGate(db, cornerId, { number: pr.number, headSha: pr.headSha })).approved;
}


export type CornerMergeGate = {
  /** A reviewer is configured. */
  reviewerExists: boolean;
  /**
   * A yes said on this exact head: a configured reviewer agent's PASS, or a
   * current Workspace owner or admin's order, or the zero-check commander's yes.
   */
  approved: boolean;
  evidenceMissing?: boolean;
  held: boolean;
  holds: Awaited<ReturnType<typeof activeCornerHolds>>;
  /** Everything but checks: a yes on this head and no hold. */
  open: boolean;
};


export type CornerMergeabilityInput = {
  checks: string;
  evidenceMissing?: boolean;
  approved: boolean;
  held: boolean;
  holds: readonly { id: string; holderId?: string; holderName?: string | null }[];
  archived: boolean;
  merged?: boolean;
  expectedHeadSha?: string | null;
  currentHeadSha: string;
  mergeability?: string;
};


/** One verdict and refusal reason for both the checks read and merge command. */
export function cornerMergeability(input: CornerMergeabilityInput) {
  const reasons = [
    input.merged ? 'the pull request is already merged' : '',
    input.archived ? 'the corner is closed' : '',
    input.expectedHeadSha && input.expectedHeadSha !== input.currentHeadSha
      ? 'PR head changed; checks and approval must match the corner head'
      : '',
    input.mergeability === 'draft' ? 'PR is a draft' : '',
    input.checks !== 'passed' ? `checks are ${input.checks}` : '',
    input.evidenceMissing ? 'missing review attachments: attach the screenshots or files claimed by the verdict' : input.approved ? '' : 'no yes on this head',
    input.held
      ? `a hold stands${input.holds.length ? `: ${input.holds.map(hold => `${hold.id}${hold.holderName ? ` (${hold.holderName}, ${hold.holderId ?? ''})` : ''}`).join('; ')}` : ''}`
      : '',
  ].filter(Boolean);
  return { mergeAllowed: reasons.length === 0, ...(reasons.length ? { blockedReason: reasons.join('; ') } : {}) };
}
