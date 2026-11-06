import { deleteCornerWakeSources } from './corner-wake-cleanup.js';
import { releaseArchivedCornerHolds } from './corner-holds.js';
import { workingTurnFreshSql } from './turn-ownership.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { reportToCommander } from './commander.js';
import { createHash } from 'node:crypto';
import { CornerLifecycleView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { insertAgentCommand as createAgentCommand, refuseVerdictedReviewerWake, currentCornerCommandTargetSql, type CommandRow } from './agent-command.js';
import { firstHealthyAgent } from './agent-health.js';
import { ensureSystemIdentity, GITHUB_SUBJECT, systemLine } from './system-line.js';
import { abandonCornerWorkflowRuns } from './workflow-runs.js';
import { cornerIdleSql, type CornerIdleRow } from './corner-idle.js';
import { CornerCheckObservation, CornerMachine, transitionCorner, loadCorner, CornerMachineFacts, CornerRow, CornerMachineEvent, deriveCornerState, planCornerCheckObservation, checksSettled, checksRestarted, actionsJobId } from './corner-lifecycle-read-state.js';
import { lockCornerArchivalAuthority, lockCornerLifecycle, CornerAdvance, blockingReview, cornerMergeGate, independentReviewerConfigured, RevisionWake, Applied, noteReviewDispatchFailure, reachableReviewer, backfillCornerLifecycleRuns, archiveCornerState, cornerReviewWokenSql, CornerMergeGate, CornerMergeabilityInput, cornerMergeability, confirmCornerMergeAuthority, deleteStoredCornerWorkflows } from './corner-lifecycle-review-state.js';
import { OK, reviewChecksSql, CORNER_LIFECYCLE_SLUG, CORNER_MACHINE_SCHEMA } from './corner-lifecycle-values.js';



export type CornerEvent =
  | {
      kind: 'open';
      command?: Parameters<typeof createAgentCommand>[1];
    }
  | { kind: 'push'; headSha: string; contents: Record<string, unknown> }
  | { kind: 'checks'; result: 'passing' | 'failing'; sourceMessageId: string; followup?: boolean }
  | {
      kind: 'brief-revised';
      revision: number;
      sourceMessageId: string;
      command: CommandRow;
    }
  /** Checks started again on the same head (a re-run); the verdict that follows is reported as `checks`. */
  | { kind: 'checks-pending' }
  /** A yes on this head: a reviewer's PASS or a person's order, landed by the caller. */
  | { kind: 'approval'; headSha: string; by: 'reviewer' | 'person' }
  | { kind: 'merge-refused'; headSha: string; reason: string; confirmedUnmerged?: boolean }
  | { kind: 'merged'; contents: Record<string, unknown> }
  | { kind: 'pull-request-closed'; number: number }
  | { kind: 'closed' }
  | { kind: 'merge-conflict'; sourceMessageId: string }
  | { kind: 'check-observation'; observation: CornerCheckObservation }
  | { kind: 'reconcile' }
  | { kind: 'command'; command: Parameters<typeof createAgentCommand>[1] };


export const CORNER_GITHUB_CACHE_MIRROR_SQL = `
INSERT INTO corner_github_cache(corner_id,lifecycle)
  SELECT corner_id,lifecycle FROM corner_facts ON CONFLICT(corner_id) DO NOTHING;
CREATE OR REPLACE FUNCTION corner_facts_lifecycle_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  INSERT INTO corner_github_cache(corner_id,lifecycle) VALUES(NEW.corner_id,NEW.lifecycle)
  ON CONFLICT(corner_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle
    WHERE corner_github_cache.lifecycle IS DISTINCT FROM EXCLUDED.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_facts_lifecycle_mirror ON corner_facts;
CREATE TRIGGER corner_facts_lifecycle_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_facts_lifecycle_mirror();
CREATE OR REPLACE FUNCTION corner_github_cache_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  UPDATE corner_facts SET lifecycle=NEW.lifecycle
    WHERE corner_id=NEW.corner_id AND lifecycle IS DISTINCT FROM NEW.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_github_cache_mirror ON corner_github_cache;
CREATE TRIGGER corner_github_cache_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_github_cache
  FOR EACH ROW EXECUTE FUNCTION corner_github_cache_mirror();
`;


/**
 * The corner's own row: created once with the corner, then changed only by
 * this module (its lock and its reviewer). Its GitHub display cache row starts
 * with it and is then written only from GitHub (`corner_github_cache`).
 */
export async function createCornerFacts(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(
    `INSERT INTO corner_facts(corner_id,lifecycle)
     VALUES($1,'{"lifecycle":"working","checks":"unknown"}') ON CONFLICT(corner_id) DO NOTHING`,
    [cornerId],
  );
  await db.query(
    `INSERT INTO corner_github_cache(corner_id) VALUES($1) ON CONFLICT(corner_id) DO NOTHING`,
    [cornerId],
  );
}


/** A person's lock: merges then keep the corner open (`corner lock`). */
export async function setCornerLockedFact(
  db: SqlDatabase,
  cornerId: string,
  locked: boolean,
): Promise<void> {
  await db.query(`UPDATE corner_facts SET locked=$2 WHERE corner_id=$1`, [cornerId, locked]);
}


/** Account deletion: corners whose own reviewer was a deleted agent fall back to their Room's. */
export async function clearCornerReviewers(db: SqlDatabase, agentIds: string[]): Promise<void> {
  await db.query(`UPDATE corner_facts SET reviewer_agent_id=NULL WHERE reviewer_agent_id=ANY($1)`, [
    agentIds,
  ]);
}


/** The corner's own reviewer; returns whether it changed. Callers check authority first. */
export async function setCornerReviewerFact(
  db: SqlDatabase,
  cornerId: string,
  reviewerId: string,
): Promise<boolean> {
  return (
    ((
      await db.query(
        `UPDATE corner_facts SET reviewer_agent_id=$2
     WHERE corner_id=$1 AND reviewer_agent_id IS DISTINCT FROM $2 RETURNING corner_id`,
        [cornerId, reviewerId],
      )
    ).rowCount ?? 0) > 0
  );
}


/**
 * Cancels every pending or claimed input/resume/restart command for a corner, and any
 * turn still marked `working`, so a corner that just landed never leaves a
 * stale assignment behind. Shared by every path that archives a corner:
 * `closeCornerState` and the GitHub merge webhook.
 * Take command locks before the room's archival UPDATE/FOR UPDATE lock:
 * command output already holds its command when dispatch locks rooms FOR SHARE.
 */
export async function cancelCornerAgentCommands(database: SqlDatabase, cornerId: string): Promise<void> {
  await lockCornerArchivalAuthority(database);
  const active = await database.query<CommandRow>(
    `SELECT * FROM agent_commands
     WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')
     ORDER BY created_at DESC,id DESC FOR UPDATE`,
    [cornerId],
  );
  // Only a claimed command has a helper turn to stop. A pending one never started;
  // cancelling it below is enough, and a stop for it would stay pending forever.
  const assignments = new Map<string, CommandRow>();
  for (const command of active.rows) {
    if (command.state !== 'claimed') continue;
    const key = `${command.agent_id}:${command.turn_request_id}`;
    if (!assignments.has(key)) assignments.set(key, command);
  }
  for (const command of assignments.values())
    await createAgentCommand(database, {
      roomId: cornerId,
      agentId: command.agent_id,
      sourceMessageId: command.source_message_id,
      turnRequestId: command.turn_request_id,
      action: 'stop',
      reason: 'corner_close',
      parent: command,
      retainDepth: true,
    });
  await database.query(
    `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,'cancelled',NULL,NULL) ended FROM agent_commands WHERE room_id=$1 AND action IN ('input','resume','restart') AND state IN ('pending','claimed')) terminal`,
    [cornerId],
  );
  await database.query(`DELETE FROM agent_pending_attachments WHERE room_id=$1`, [cornerId]);
}



export async function archiveCorner(database: SqlDatabase, cornerId: string): Promise<boolean> {
  return database.transaction(async database => {
    await lockCornerLifecycle(database, cornerId);
    await lockCornerArchivalAuthority(database);
    if (!(await database.query(`SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NOT NULL FOR KEY SHARE`, [cornerId])).rowCount)
      throw new Error('corner not found');
    await cancelCornerAgentCommands(database, cornerId);
    // Match command output: command locks precede the Room archival write lock.
    const changed = await database.query(
      `UPDATE rooms SET archived_at=now(),updated_at=now() WHERE id=$1 AND archived_at IS NULL`, [cornerId]);
    await abandonCornerWorkflowRuns(database, cornerId);
    await deleteCornerWakeSources(database, [cornerId]);
    await releaseArchivedCornerHolds(database, [cornerId]);
    return Boolean(changed.rowCount);
  });
}


export async function advanceCorner(
  database: SqlDatabase,
  cornerId: string,
  event: CornerEvent,
): Promise<CornerAdvance> {
  // Admission is not a committed activity fact. Preserve the queue's lock
  // order (queue -> command -> Room); its committed event updates the machine.
  if (event.kind === 'command') return database.transaction(async db => {
    const current = (await db.query<{ machine: CornerMachine | null }>('SELECT machine FROM corner_facts WHERE corner_id=$1', [cornerId])).rows[0]?.machine ?? { state: 'idle' as const };
    const plan = transitionCorner(current, { facts: { archived: false, turnRunning: false }, event });
    const command = plan.wakes.length ? await createAgentCommand(db, event.command) : undefined;
    return { state: current.state, accepted: Boolean(command), ...(command ? { command } : {}) };
  });
  return database.transaction(async (db) => {
    await lockCornerLifecycle(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    if (!corner) return { accepted: false, state: undefined };
    const head = corner.lifecycle.pr?.headSha ?? (event.kind === 'push' ? event.headSha : undefined);
    await ensureSystemIdentity(db);
    const row = (await db.query<CornerIdleRow>(cornerIdleSql('$1', true), [cornerId])).rows[0];
    const sourceHead =
      event.kind === 'checks'
        ? (
            await db.query<{ head: string | null }>(
              `SELECT system_event->'object'->>'headSha' head FROM messages WHERE id=$1 AND room_id=$2`,
              [event.sourceMessageId, cornerId],
            )
          ).rows[0]?.head
        : undefined;
    const checkSource = (
      await db.query<{ id: string; followup: boolean }>(
        `SELECT id,COALESCE((system_event->'payload'->>'followup')::boolean,false) followup FROM messages WHERE room_id=$1
      AND system_event->>'kind'=$2 AND (system_event->'object'->>'headSha' IS NULL OR system_event->'object'->>'headSha'=$3)
      ORDER BY created_at DESC,id DESC LIMIT 1`,
        [
          cornerId,
          corner.lifecycle.checks === 'failing' ? 'check-failed' : 'check-passed',
          head ?? null,
        ],
      )
    ).rows[0];
    const ended = head ? await blockingReview(db, cornerId, head) : undefined;
    const completed = head
      ? (
          await db.query<{ id: string; findings: string | null; reported: boolean }>(
            `SELECT command.id,result.text findings,COALESCE(command.private_payload->>'reportedOutcome',command.report_outcome) IN ('failed','blocked') reported
      FROM agent_commands command LEFT JOIN messages result ON result.id=command.result_message_id
      WHERE command.room_id=$1 AND command.review_context->>'headSha'=$2
        AND command.review_context->'pullRequest'=$3::jsonb AND command.review_context->>'purpose' IS NULL
        AND command.action='input' AND ($4::text IS NULL OR command.agent_id=$4) AND NOT EXISTS (SELECT 1 FROM agent_turns running
          WHERE running.room_id=command.room_id AND running.agent_id=command.agent_id
            AND running.request_id=command.turn_request_id AND running.status='working' AND ${workingTurnFreshSql('running')})
        AND (command.state='complete' OR command.state='cancelled' AND EXISTS (
          SELECT 1 FROM agent_turns turn WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
            AND turn.request_id=command.turn_request_id AND turn.status<>'working'))
      ORDER BY command.completed_at DESC NULLS LAST,command.created_at DESC LIMIT 1`,
            [cornerId, head, JSON.stringify(corner.lifecycle.pr?.number), corner.configured_reviewer_id],
          )
        ).rows[0]
      : undefined;
    const evidence = ended
      ? (
          await db.query<{ text: string }>(
            'SELECT result.text FROM agent_commands command JOIN messages result ON result.id=command.result_message_id WHERE command.id=$1',
            [ended],
          )
        ).rows[0]?.text
      : undefined;
    // Completed commands still prove delivery; only missing IDs invalidate their receipts.
    const receipts = (corner.machine?.effects ?? []).filter(key => key.startsWith('command:red:')).map(marker => ({
      marker, key: marker.slice('command:'.length, marker.lastIndexOf(':')), id: marker.slice(marker.lastIndexOf(':') + 1),
    }));
    const active = (
      await db.query<{ worker: boolean; reviewer: boolean; conflict: boolean; retained: string[] | null }>(
        `SELECT
      EXISTS(SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2
        AND state IN ('pending','claimed') AND action IN ('input','resume') AND reason<>'report' AND ${currentCornerCommandTargetSql('agent_commands')}) worker,
      EXISTS(SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$3 AND (state IN ('pending','claimed') OR EXISTS(SELECT 1 FROM agent_turns running
          WHERE running.room_id=agent_commands.room_id AND running.agent_id=agent_commands.agent_id
            AND running.request_id=agent_commands.turn_request_id AND running.status='working' AND ${workingTurnFreshSql('running')}))
        AND action='input' AND review_context->>'purpose' IS NULL
        AND review_context->>'headSha'=$4 AND review_context->'pullRequest'=$5::jsonb
        AND COALESCE((review_context->>'briefRevision')::int,0)=COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$1),0)) reviewer,
      EXISTS(SELECT 1 FROM agent_commands delivered JOIN messages source ON source.id=delivered.source_message_id
        WHERE delivered.room_id=$1 AND delivered.reason='corner_merge_conflict'
          AND source.system_event->'object'->>'headSha'=$4) conflict,
      (SELECT array_agg(id) FROM agent_commands WHERE id=ANY($6::text[])) retained`,
        [
          cornerId,
          corner.worker_agent_id,
          corner.configured_reviewer_id,
          head ?? null,
          JSON.stringify(corner.lifecycle.pr?.number ?? null),
          receipts.map(receipt => receipt.id),
        ],
      )
    ).rows[0];
    const waitText = row?.waiting_item_id
      ? (
          await db.query<{ text: string | null }>(
            `SELECT COALESCE(
      (SELECT private_payload->>'text' FROM agent_commands WHERE id=$1),
      (SELECT text FROM messages WHERE id=$1)) text`,
            [row.waiting_item_id],
          )
        ).rows[0]?.text
      : undefined;
    const gate =
      head && corner.lifecycle.pr?.number
        ? await cornerMergeGate(db, cornerId, { number: corner.lifecycle.pr.number, headSha: head })
        : undefined;
    const facts: CornerMachineFacts = {
      archived: corner.archived,
      locked: corner.locked,
      lifecycle: corner.lifecycle,
      headSha: head,
      turnRunning: row?.worker_active === true || active?.worker === true,
      reviewerActive: row?.reviewer_active === true || active?.reviewer === true,
      approved: gate?.approved,
      mergeHeld: gate?.held,
      mergeConflictDelivered: active?.conflict,
      lostEffects: receipts.filter(receipt => !active?.retained?.includes(receipt.id)).flatMap(receipt => [receipt.key, receipt.marker]),
      draftReadyFailure: (corner.lifecycle as CornerLifecycleView & { draftReadyFailure?: { headSha?: string } }).draftReadyFailure?.headSha === head && Boolean(head),
      reviewerConfigured: independentReviewerConfigured(corner),
      ...(/^blocked:/.test(waitText ?? '') ? { waitReason: 'blocked' as const } : {}),
      ...(ended || completed
        ? {
            reviewEnded: {
              id: ended ?? completed!.id,
              reported: completed?.reported,
              ...(ended
                ? { findings: evidence ?? 'The reviewer requested changes on this head.' }
                : {}),
            },
          }
        : {}),
      ...(row && row.waiting_item_id && row.waiting_reason
        ? {
            blocker: {
              reason: row.waiting_reason,
              itemId: row.waiting_item_id,
              ...(row.waiting_kind ? { blocker: { kind: row.waiting_kind } } : {}),
            },
          }
        : {}),
      checkSourceId:
        sourceHead && sourceHead !== head
          ? 'stale'
          : event.kind === 'checks'
            ? event.sourceMessageId
            : checkSource?.id ?? (corner.lifecycle.checks === 'failing' && head
              ? `cache:${head}` : undefined),
      checkFollowup: checkSource?.followup,
      checkAttempt: (corner.lifecycle.checksSummary as { attempt?: number } | undefined)?.attempt,
      idleSince: row?.idle_since,
      idleEligible: row
        ? !row.suppressed && !row.worker_active && !row.reviewer_active && !row.blocking
        : false,
    };
    const prior = corner.machine ?? { state: 'idle' };
    const plan = transitionCorner(prior, { facts, event });
    if (plan.suppression) return { state: prior.state, accepted: false };
    const archived = plan.state.state === 'archived' && !corner.archived &&
      (event.kind === 'closed' || event.kind === 'merged' || corner.lifecycle.outcome === 'landed' || corner.lifecycle.pr?.mergedAt)
      ? await archiveCorner(db, cornerId) : false;
    if (event.kind === 'closed') await db.query(
      `UPDATE corner_github_cache SET lifecycle=lifecycle||'{"lifecycle":"done","checks":"unknown"}'::jsonb WHERE corner_id=$1`, [cornerId]);
    let wakeResult: RevisionWake | undefined;
    const effects = [...(plan.state.effects ?? [])];
    for (const effect of plan.wakes) {
      let result: Applied = OK;
      const sourceId = event.kind === 'checks' ? event.sourceMessageId : checkSource?.id;
      switch (effect.kind) {
        case 'merge-conflict': {
          const source =
            event.kind === 'merge-conflict'
              ? event.sourceMessageId
              : (
                  await systemLine(db, {
                    id: createHash('sha256')
                      .update(
                        `beeline:${cornerId}:github:merge-conflict:${corner.lifecycle.pr?.number}:${head}`,
                      )
                      .digest('hex'),
                    roomId: cornerId,
                    authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
                    subject: GITHUB_SUBJECT,
                    verb: systemMessage('agent-command.found-merge-conflicts-in'),
                    object: { text: corner.lifecycle.pr?.title ?? 'Pull request', headSha: head },
                  })
                ).id;
          const command = corner.worker_agent_id
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId: corner.worker_agent_id,
                sourceMessageId: source,
                reason: 'corner_merge_conflict',
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
        case 'open': {
          const command =
            event.kind === 'open' && event.command
              ? await createAgentCommand(db, event.command)
              : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
        case 'revision': {
          if (event.kind !== 'brief-revised') break;
          const agentId = corner.worker_agent_id
            ? await firstHealthyAgent(db, cornerId, [corner.worker_agent_id])
            : null;
          const command = agentId
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId,
                sourceMessageId: event.sourceMessageId,
                reason: 'corner_brief_revision',
                parent: event.command,
                retainDepth: true,
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : { reason: 'No reachable implementer for the revision' }) },
          };
          break;
        }
        case 'checks-failed':
          if (!corner.worker_agent_id) {
            await noteReviewDispatchFailure(db, cornerId, head ?? 'checks', 'the corner has no implementer');
            result = { ok: true, wake: { queued: false, reason: 'the corner has no implementer' } };
          } else if (facts.checkSourceId && corner.worker_agent_id) {
            const command = await createAgentCommand(db, {
              roomId: cornerId,
              agentId: corner.worker_agent_id,
              sourceMessageId: sourceId ?? null,
              ...(!sourceId ? { id: createHash('sha256').update(`cached-checks:${cornerId}:${corner.lifecycle.pr?.number}:${head}:${facts.checkAttempt ?? 0}`).digest('hex'),
                privatePayload: { kind: 'lifecycle' as const, authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId,
                  text: `Failing checks on head ${head}: ${corner.lifecycle.checksSummary?.failing.length ? corner.lifecycle.checksSummary.failing.join(', ') : 'the recorded checks failed; read the current checks for details'}. Fix these recorded failures.` } } : {}),
              reason: 'corner_check',
            });
            if (command) effects.push(`command:${effect.key}:${command.id}`);
            if (command && !sourceId) await db.query(`UPDATE agent_commands SET review_context=jsonb_build_object(
              'cornerId',$2::text,'headSha',$3::text,'pullRequest',$4::int,'briefRevision',
              COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$2::uuid),0),'purpose','repair') WHERE id=$1`,
              [command.id,cornerId,head,corner.lifecycle.pr?.number]);
            result = {
              ok: true,
              wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
            };
          }
          break;
        case 'review': {
          const reviewer = await reachableReviewer(db, cornerId, corner, sourceId ?? cornerId);
          if (!reviewer) {
            result = await noteReviewBlocked(
              db,
              cornerId,
              corner,
              head!,
              'the configured reviewer is unreachable',
              false,
            );
            break;
          }
          const source =
            event.kind === 'checks' && sourceId ? sourceId :
            (
              await systemLine(db, {
                roomId: cornerId,
                authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
                subject: GITHUB_SUBJECT,
                verb: systemMessage('corner-lifecycle.requested-review-of'),
                object: { text: corner.lifecycle.pr?.title ?? 'Pull request', headSha: head },
              })
            ).id;
          const queued = await queueReviewerCommand(db, {
            roomId: cornerId,
            agentId: reviewer,
            sourceMessageId: source,
            reason: event.kind === 'checks' ? 'subscribed_event' : 'corner_review_dispatch',
          });
          result = queued.command
            ? { ok: true, wake: { queued: true, agentId: reviewer } }
            : queued.blocked
              ? OK
              : await noteReviewBlocked(
                  db,
                  cornerId,
                  corner,
                  head!,
                  `the reviewer command could not be queued${queued.error ? `: ${queued.error}` : ''}`,
                );
          // Lost/cancelled unclaimed review commands are recoverable. Durable
          // command facts, rather than an effect receipt, suppress live reviews.
          break;
        }
        case 'review-gap':
          result = await noteMissingReviewer(
            db,
            cornerId,
            corner,
            `${corner.lifecycle.pr?.number}:${head}`,
          );
          break;
        case 'review-findings':
          result = await noteReviewBlocked(
            db,
            cornerId,
            corner,
            `${head}:${facts.reviewEnded!.id}`,
            `the reviewer completed its review of the current head ${head}.\n${facts.reviewEnded!.findings}`,
            false,
          );
          break;
        case 'review-no-verdict':
          result = await noteMissingReviewVerdict(db, cornerId, corner, head!, facts.reviewEnded?.reported);
          break;
        case 'land':
          if (corner.worker_agent_id) {
            const command = await createAgentCommand(db, {
              id: createHash('sha256')
                .update(`corner-land:${cornerId}:${corner.lifecycle.pr?.number}:${head}`)
                .digest('hex'),
              roomId: cornerId,
              agentId: corner.worker_agent_id,
              sourceMessageId: null,
              reason: 'corner_land',
              privatePayload: {
                kind: 'lifecycle',
                authorId: SYSTEM_IDENTITY_ID,
                fromRoomId: cornerId,
                text: `A yes is recorded on ${head} and checks passed. Call merge_corner through the normal merge gate.`,
              },
            });
            result = {
              ok: true,
              wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
            };
          }
          break;
        case 'merge-refused': {
          if (event.kind !== 'merge-refused') break;
          const line = await systemLine(db, {
            roomId: cornerId,
            authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
            subject: GITHUB_SUBJECT,
            verb: systemMessage('corner-lifecycle.refused-to-merge'),
            object: { text: corner.lifecycle.pr?.title ?? 'Pull request', headSha: head },
            consequence: event.reason,
          });
          const command = corner.worker_agent_id
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId: corner.worker_agent_id,
                sourceMessageId: line.id,
                reason: 'corner_merge_refused',
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
      }
      if (result.wake) wakeResult = result.wake;
      if (!['review', 'command'].includes(effect.kind) && (result.wake?.queued || !result.wake))
        effects.push(effect.key);
    }
    for (const notice of plan.notifications) {
      if (notice.kind === 'draft') await reportToCommander(db, cornerId, corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
        systemMessage('agent-command.blocked-pr-is-a-draft-marking-it-ready-for-review-failed'), undefined,
        createHash('sha256').update(`draft-blocked:${cornerId}:${head}`).digest('hex'));
      if (notice.kind === 'idle' && row) {
        await reportToCommander(
          db,
          cornerId,
          SYSTEM_IDENTITY_ID,
          `blocked: Corner ${row.name} is idle. Resume it, set a hold, or close it.`,
          undefined,
          createHash('sha256').update(`idle:${cornerId}:${row.idle_since}`).digest('hex'),
          { automatic: true, agentOnly: true, wakeInCorner: true, idleSince: row.idle_since },
        );
      }
      // Explicit reports, owed asks and action cards already deliver to their
      // commander. The machine records the wait; it never broadcasts to Room people.
      effects.push(notice.key);
    }
    // Committed command activity invalidates idle delivery immediately through its fact guard.
    await db.query(
      `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,'cancelled','stale_idle_alert',NULL) ended
      FROM agent_commands WHERE state='pending' AND reason='report' AND private_payload->>'authorId'=$3
        AND private_payload->>'idleSince' IS NOT NULL AND COALESCE(private_payload->>'originCornerId',private_payload->>'fromRoomId')=$1::text
        AND private_payload->>'idleSince' IS DISTINCT FROM $2::text) terminal`,
      [cornerId, plan.state.state === 'idle' ? facts.idleSince : null, SYSTEM_IDENTITY_ID],
    );
    const state = { ...plan.state, effects };
    await db.query(
      'UPDATE corner_facts SET machine=$2::jsonb WHERE corner_id=$1 AND machine IS DISTINCT FROM $2::jsonb',
      [cornerId, JSON.stringify(state)],
    );
    return {
      state: state.state,
      accepted: true,
      ...(archived ? { archived: true } : {}),
      ...(wakeResult ? { wake: wakeResult } : {}),
    };
  });
}


/** Zero checks need the commander's yes; other review gaps retain their handback. */
export async function noteMissingReviewer(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headKey: string,
): Promise<Applied> {
  if (corner.lifecycle.checksSummary?.total === 0) {
    const command = corner.worker_agent_id
      ? await createAgentCommand(db, {
          id: createHash('sha256').update(`zero-check-ready:${cornerId}:${headKey}`).digest('hex'),
          roomId: cornerId,
          agentId: corner.worker_agent_id,
          sourceMessageId: null,
          privatePayload: {
            text: "This pull request has no checks and no reviewer. Landing needs your commander's yes. Ask your commander using your normal report tool.",
            authorId: SYSTEM_IDENTITY_ID,
            fromRoomId: cornerId,
            kind: 'lifecycle',
          },
          reason: 'corner_review_needed',
        })
      : undefined;
    return {
      ok: true,
      wake: command
        ? { queued: true, agentId: corner.worker_agent_id! }
        : {
            queued: false,
            reason: 'The implementer cannot be woken to ask its commander for a merge decision',
          },
    };
  }
  return noteReviewBlocked(
    db,
    cornerId,
    corner,
    headKey,
    systemMessage('corner-lifecycle.no-reviewer-is-configured'),
  );
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
  if (reportCommander)
    await reportToCommander(
      db,
      cornerId,
      SYSTEM_IDENTITY_ID,
      systemMessage('corner-lifecycle.blocked', reason),
      undefined,
      createHash('sha256').update(`review-gap:${episode}`).digest('hex'),
    );
  const command = corner.worker_agent_id
    ? await createAgentCommand(db, {
        id: createHash('sha256').update(`review-needed:${episode}`).digest('hex'),
        roomId: cornerId,
        agentId: corner.worker_agent_id,
        sourceMessageId: null,
        privatePayload: {
          text: `${corner.lifecycle.checks === 'passing' ? 'Checks passed; ' : ''}${reason}; arrange review or report the blocker to its commander`,
          authorId: SYSTEM_IDENTITY_ID,
          fromRoomId: cornerId,
          kind: 'lifecycle',
        },
        reason: 'corner_review_needed',
      })
    : undefined;
  const wakeResult = command
    ? { queued: true, agentId: corner.worker_agent_id! }
    : {
        queued: false,
        reason: systemMessage('corner-lifecycle.the-implementer-cannot-be-woken-to-arrange-review'),
      };
  if (!command) await noteReviewDispatchFailure(db, cornerId, headKey, wakeResult.reason!);
  return { ok: true, wake: wakeResult };
}


/** Exhausted empty reviews are a private missing-verdict handback, never a completed review. */
export async function noteMissingReviewVerdict(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headSha: string,
  reported = false,
): Promise<Applied> {
  const text = `blocked: the reviewer ended without a verdict on head ${headSha}; arrange review or restore reviewer access`;
  const key = `${cornerId}:${corner.lifecycle.pr?.number}:${headSha}`;
  if (!reported) await reportToCommander(
    db,
    cornerId,
    SYSTEM_IDENTITY_ID,
    text,
    undefined,
    createHash('sha256').update(`review-no-verdict:${key}`).digest('hex'),
    { automatic: true, agentOnly: true },
  );
  const command = corner.worker_agent_id
    ? await createAgentCommand(db, {
        id: createHash('sha256')
          .update(`review-no-verdict-worker:${key}`)
          .digest('hex'),
        roomId: cornerId,
        agentId: corner.worker_agent_id,
        sourceMessageId: null,
        privatePayload: {
          text,
          authorId: SYSTEM_IDENTITY_ID,
          fromRoomId: cornerId,
          kind: 'lifecycle',
        },
        reason: 'corner_review_needed',
      })
    : undefined;
  return {
    ok: true,
    wake: { queued: Boolean(command), ...(command ? { agentId: corner.worker_agent_id! } : {}) },
  };
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
  const context = (
    await db.query<{ context: Record<string, unknown> | null }>(
      `SELECT CASE WHEN lifecycle->'pr'->>'headSha' IS NOT NULL AND lifecycle->'pr'->>'number' IS NOT NULL
       THEN jsonb_build_object('cornerId',corner_id,'headSha',lifecycle->'pr'->>'headSha',
       'pullRequest',lifecycle->'pr'->'number','briefRevision',$2::int,
       'checks',${reviewChecksSql}) ELSE NULL END context
     FROM corner_github_cache WHERE corner_id=$1`,
      [input.roomId, brief?.revision ?? 0],
    )
  ).rows[0]?.context;
  const headSha = typeof context?.headSha === 'string' ? context.headSha : undefined;
  const rawPull = context?.pullRequest;
  const pullRequest =
    typeof rawPull === 'number'
      ? rawPull
      : typeof rawPull === 'string' && /^\d+$/.test(rawPull)
        ? Number(rawPull)
        : null;
  if (
    headSha !== undefined &&
    (await refuseVerdictedReviewerWake(db, input.roomId, input.agentId, headSha, pullRequest))
  )
    return { blocked: true };
  const prior = (
    await db.query<{ text: string }>(
      `SELECT result.text FROM agent_commands command JOIN messages result ON result.id=command.result_message_id
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.review_context IS NOT NULL
       AND command.state='complete' ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
      [input.roomId, input.agentId],
    )
  ).rows[0]?.text;
  // A rejected insert must leave this transaction usable so the failure line
  // can commit. A broken connection still propagates rather than pretending
  // the reviewer was woken.
  await db.query('SAVEPOINT corner_reviewer_dispatch');
  try {
    const command = await createAgentCommand(db, {
      ...input,
      wakeNote: [
        context
          ? `Current handoff target: PR #${context.pullRequest} at ${context.headSha}. Older heads in the conversation are historical.`
          : '',
        brief
          ? `Review against brief revision ${brief.revision}, the corner's current brief at this dispatch.`
          : '',
        prior ? `Prior reviewer verdict and evidence (historical context):\n${prior}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    if (command)
      await db.query('UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1', [
        command.id,
        context ? JSON.stringify(context) : null,
      ]);
    if (command) command.review_context = context as Record<string, unknown> | null;
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return { command };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT corner_reviewer_dispatch');
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return {
      error:
        error instanceof Error
          ? error.message.slice(0, 160)
          : systemMessage('corner-lifecycle.unknown-dispatch-error'),
    };
  }
}
export { CORNER_LIFECYCLE_SLUG } from './corner-lifecycle-values.js';

export { lockCornerLifecycle } from './corner-lifecycle-review-state.js';

export type { CornerMachine } from './corner-lifecycle-read-state.js';

export type { CornerMachineFacts } from './corner-lifecycle-read-state.js';

export type { CornerMachineEvent } from './corner-lifecycle-read-state.js';

export { transitionCorner } from './corner-lifecycle-read-state.js';

export { deriveCornerState } from './corner-lifecycle-read-state.js';

export { planCornerCheckObservation } from './corner-lifecycle-read-state.js';

export { checksSettled } from './corner-lifecycle-read-state.js';

export { checksRestarted } from './corner-lifecycle-read-state.js';

export { actionsJobId } from './corner-lifecycle-read-state.js';

export type { CornerAdvance } from './corner-lifecycle-review-state.js';

export { CORNER_MACHINE_SCHEMA } from './corner-lifecycle-values.js';

export { backfillCornerLifecycleRuns } from './corner-lifecycle-review-state.js';

export { lockCornerArchivalAuthority } from './corner-lifecycle-review-state.js';

export { archiveCornerState } from './corner-lifecycle-review-state.js';

export { cornerReviewWokenSql } from './corner-lifecycle-review-state.js';

export { blockingReview } from './corner-lifecycle-review-state.js';

export type { CornerMergeGate } from './corner-lifecycle-review-state.js';

export type { CornerMergeabilityInput } from './corner-lifecycle-review-state.js';

export { cornerMergeability } from './corner-lifecycle-review-state.js';

export { cornerMergeGate } from './corner-lifecycle-review-state.js';

export { confirmCornerMergeAuthority } from './corner-lifecycle-review-state.js';

export { deleteStoredCornerWorkflows } from './corner-lifecycle-review-state.js';
