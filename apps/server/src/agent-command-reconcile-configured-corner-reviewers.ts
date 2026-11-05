import { subscribeConfiguredReviewers } from './agent-subscriptions.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerOwnerSql } from './corner-worker.js';
import { cornerRunStateSql } from './corner-run.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { advanceCorner } from './corner-lifecycle.js';
import { cornerImplementerSql } from './corner-worker.js';
import { systemLine } from './system-line.js';



/**
 * Restore the two durable projections of a configured reviewer.
 *
 * Room configuration is the dispatch authority. The subscription remains a
 * visible description of what wakes the reviewer, but losing or overwriting
 * that projection must not lose a review. Existing green heads are dispatched
 * from their latest check fact when the lifecycle is ready and no review
 * command is pending or running on that head.
 */
export async function reconcileConfiguredCornerReviewers(
  db: SqlDatabase,
  parentRoomId?: string,
): Promise<{ subscriptions: number; commands: number }> {
    db = new CornerAccessDatabase(db);
  const subscriptions = await subscribeConfiguredReviewers(db, [parentRoomId ?? null]);
  // Older webhook deliveries could persist a green lifecycle while their
  // deduplicated GitHub note never created a check-passed fact. Give those
  // heads a durable source for both review dispatch and reviewer handback.
  const missingFacts = await db.query<{
    corner_id: string;
    author_id: string;
    head_sha: string;
  }>(
    `SELECT corner.id corner_id,COALESCE(${cornerOwnerSql('corner.id')},corner.created_by) author_id,
            gh.lifecycle->'pr'->>'headSha' head_sha
     FROM rooms corner
     JOIN rooms parent ON parent.id=corner.parent_id
     JOIN (corner_facts fact JOIN corner_github_cache gh ON gh.corner_id=fact.corner_id) ON fact.corner_id=corner.id
     JOIN memberships reviewer ON reviewer.room_id=parent.id
       AND reviewer.identity_id=${cornerReviewerSql()} AND reviewer.removed_at IS NULL
     WHERE corner.archived_at IS NULL AND gh.lifecycle->>'checks'='passing'
       AND gh.lifecycle->'pr'->>'number' IS NOT NULL
       AND gh.lifecycle->'pr'->>'headSha' IS NOT NULL
       AND COALESCE(${cornerOwnerSql('corner.id')},corner.created_by) IS NOT NULL
       AND ($1::uuid IS NULL OR parent.id=$1)
       AND NOT EXISTS (
         SELECT 1 FROM agent_commands worker
         WHERE worker.room_id=corner.id
           AND worker.agent_id=${cornerImplementerSql('fact', 'corner')}
           AND worker.action='input' AND worker.state IN ('pending','claimed')
       )
       AND NOT EXISTS (
         SELECT 1 FROM corner_merge_approvals approval
         WHERE approval.corner_id=corner.id
           AND approval.approved_by=${cornerReviewerSql()}
           AND approval.pull_request_number=(gh.lifecycle->'pr'->>'number')::integer
           AND approval.head_sha=gh.lifecycle->'pr'->>'headSha'
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages message WHERE message.room_id=corner.id
           AND message.system_event->>'kind'='check-passed'
           AND (message.system_event->'object'->>'headSha' IS NULL
                OR message.system_event->'object'->>'headSha'=gh.lifecycle->'pr'->>'headSha')
       )`,
    [parentRoomId ?? null],
  );
  let commands = 0;
  if (missingFacts.rows.length) {
    for (const missing of missingFacts.rows) {
      const source = await systemLine(db, {
        id: createHash('sha256')
          .update(`beeline:${missing.corner_id}:recovered-green:${missing.head_sha}`)
          .digest('hex'),
        roomId: missing.corner_id,
        authorId: missing.author_id,
        subject: { kind: 'github', name: systemMessage("agent-command.github") },
        verb: systemMessage("agent-command.passed-checks"),
        kind: 'check-passed',
        object: { text: systemMessage("agent-command.aggregate-checks"), headSha: missing.head_sha },
      });
      const routed = await db.query(
        `SELECT 1 FROM agent_commands WHERE room_id=$1 AND source_message_id=$2
           AND agent_id=(SELECT ${cornerReviewerSql()} FROM rooms corner JOIN rooms parent ON parent.id=corner.parent_id WHERE corner.id=$1)`,
        [missing.corner_id, source.id],
      );
      if (source.inserted && routed.rowCount) commands += 1;
    }
  }
  const candidates = await db.query<{
    corner_id: string;
    reviewer_agent_id: string | null;
    source_message_id: string;
    head_sha: string | null;
  }>(
    `SELECT corner.id corner_id,${cornerReviewerSql()} reviewer_agent_id,source.id source_message_id,
            gh.lifecycle->'pr'->>'headSha' head_sha
     FROM rooms corner
     JOIN rooms parent ON parent.id=corner.parent_id
     JOIN (corner_facts fact JOIN corner_github_cache gh ON gh.corner_id=fact.corner_id) ON fact.corner_id=corner.id
     JOIN LATERAL (
       SELECT message.id
       FROM messages message
       WHERE message.room_id=corner.id
         AND message.system_event->>'kind'='check-passed'
         AND (message.system_event->'object'->>'headSha' IS NULL
              OR message.system_event->'object'->>'headSha'=gh.lifecycle->'pr'->>'headSha')
       ORDER BY message.created_at DESC,message.id DESC LIMIT 1
     ) source ON true
     WHERE corner.archived_at IS NULL
       AND ${cornerRunStateSql('fact.corner_id')} IS DISTINCT FROM 'ask_human'
       AND gh.lifecycle->>'checks'='passing'
       AND gh.lifecycle->'pr'->>'number' IS NOT NULL
       AND gh.lifecycle->'pr'->>'headSha' IS NOT NULL
       AND ($1::uuid IS NULL OR parent.id=$1)
       AND NOT EXISTS (
         SELECT 1 FROM agent_commands worker
         WHERE worker.room_id=corner.id
           AND worker.agent_id=${cornerImplementerSql('fact', 'corner')}
           AND worker.action='input' AND worker.state IN ('pending','claimed')
       )
       AND NOT EXISTS (
         SELECT 1 FROM corner_merge_approvals approval
         WHERE approval.corner_id=corner.id
           AND approval.approved_by=${cornerReviewerSql()}
           AND approval.pull_request_number=(gh.lifecycle->'pr'->>'number')::integer
           AND approval.head_sha=gh.lifecycle->'pr'->>'headSha'
       )
       AND NOT EXISTS (
         SELECT 1 FROM agent_commands command
         JOIN messages dispatch ON dispatch.id=command.source_message_id
         WHERE command.room_id=corner.id
           AND command.agent_id=${cornerReviewerSql()}
           AND command.state IN ('pending','claimed') AND command.action='input'
           AND (command.reason='corner_review_dispatch'
             OR (command.reason='subscribed_event' AND
               (dispatch.system_event->>'kind'='check-passed'
                 OR dispatch.author_id=${cornerImplementerSql('fact', 'corner')}))
             OR (command.reason='agent_tag' AND dispatch.author_id=${cornerImplementerSql('fact', 'corner')}))
           AND (dispatch.system_event->'object'->>'headSha' IS NULL
                OR dispatch.system_event->'object'->>'headSha'=gh.lifecycle->'pr'->>'headSha')
       )`,
    [parentRoomId ?? null],
  );
  for (const candidate of candidates.rows) {
    // Re-report the green head. A review state repairs a missing wake; an
    // implement state waits for its current worker before taking rereview.
    const outcome = await advanceCorner(db, candidate.corner_id, {
      kind: 'checks',
      result: 'passing',
      sourceMessageId: candidate.source_message_id,
    });
    const routed = await db.query(
      `SELECT 1 FROM agent_commands WHERE room_id=$1 AND source_message_id=$2 AND agent_id=$3
         AND state IN ('pending','claimed')`,
      [candidate.corner_id, candidate.source_message_id, candidate.reviewer_agent_id],
    );
    if (outcome.wake?.queued || routed.rowCount) commands += 1;
  }
  return { subscriptions: subscriptions.rowCount, commands };
}
