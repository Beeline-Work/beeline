import {commandOwnerLiveSql} from './turn-ownership.js';
import { cornerOwedAnswerTimesSql, cornerReportAnswerTimesSql } from './corner-owed.js';
import { cornerRunOutcomeSql, cornerRunStateSql } from './corner-run.js';
import { cornerImplementerSql } from './corner-worker.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { cornerBlockerSql, cornerRowState, cornerScheduledWaitSql, cornerWorkSql,
  type CornerStateRow } from './chat-corner-counts.js';

export type CornerIdleRow = CornerStateRow & {
  id: string;
  name: string;
  parent_id: string;
  /** Epoch seconds kept as text to preserve PostgreSQL's microsecond precision. */
  idle_since: string;
  suppressed: boolean;
};

/**
 * One source for attention, delivery and claim. No mutable episode state.
 * Deleted schedules have no surviving end timestamp; expired schedules alone,
 * without another event, do not open a new idle episode.
 */
export function cornerIdleSql(cornerId: string): string {
  return `WITH live_corner AS MATERIALIZED (
    SELECT * FROM rooms WHERE id=${cornerId} AND parent_id IS NOT NULL AND archived_at IS NULL
  ) SELECT snapshot.*,
    NOT (archived_at IS NOT NULL OR
      NOT COALESCE(locked,false) AND (
        COALESCE(workflow_state IN ('landed','closed'),false)
        OR lower(btrim(COALESCE(lifecycle->>'lifecycle','')))='done'
        OR COALESCE(lifecycle->>'outcome' IN ('landed','abandoned'),false)
        OR NULLIF(lifecycle->'pr'->>'mergedAt','') IS NOT NULL) OR
      worker_active OR reviewer_active OR blocking OR suppressed OR
      COALESCE(lifecycle->'checksSummary'->>'status',lifecycle->>'checks','')='pending' OR
      COALESCE(lifecycle->'checksSummary'->'checks','[]'::jsonb) @> '[{"status":"pending"}]'::jsonb
    ) idle_eligible
    FROM (SELECT c.id,c.name,c.parent_id,c.archived_at,gh.lifecycle,f.locked,
      ${cornerRunStateSql('c.id')} workflow_state,${cornerRunOutcomeSql('c.id')} workflow_outcome,
      activity.worker_active,activity.reviewer_active,NULL::text latest_turn_status,
      blocker.item_id IS NOT NULL blocking,blocker.item_id waiting_item_id,
      blocker.reason waiting_reason,blocker.kind waiting_kind,blocker.person_id waiting_person_id,
      CASE WHEN ended.status='complete' AND ended.ended_at>=boundary.at THEN ended.ended_at END last_turn_ended_at,
      extract(epoch FROM GREATEST(c.created_at,ended.ended_at,boundary.at,
        to_timestamp(COALESCE(gh.lifecycle->'checksSummary'->>'statusChangedAt',
          gh.lifecycle->'checksSummary'->>'updatedAt')::double precision)))::text idle_since,
      (${cornerScheduledWaitSql('c')}
        OR EXISTS(SELECT 1 FROM agent_commands unresolved JOIN agent_command_owner_ends ended_owner
          ON ended_owner.command_id=unresolved.id AND ended_owner.generation_id=unresolved.generation_id
          WHERE unresolved.room_id=c.id AND unresolved.state='claimed')
        OR EXISTS(SELECT 1 FROM corner_merge_holds WHERE corner_id=c.id AND released_at IS NULL)
        OR EXISTS(SELECT 1 FROM agent_commands queued WHERE queued.room_id=c.id AND queued.action='input'
          AND (queued.state='pending' OR (queued.state='claimed' AND ${commandOwnerLiveSql('queued')}))
          AND queued.review_context->>'headSha'=gh.lifecycle->'pr'->>'headSha'
          AND queued.review_context->>'purpose' IS NULL AND queued.agent_id IS DISTINCT FROM ${cornerImplementerSql('f', 'c')})
        OR gh.lifecycle->>'checks'='pending'
        OR (NULLIF(gh.lifecycle->'pr','null'::jsonb) IS NOT NULL AND gh.lifecycle->'checksSummary'->>'status'='unknown'
          AND gh.lifecycle->'checksSummary'->>'fetchStartedAt' IS NULL)
      ) IS TRUE suppressed
      FROM live_corner c JOIN corner_facts f ON f.corner_id=c.id
      LEFT JOIN corner_github_cache gh ON gh.corner_id=c.id
      ${cornerWorkSql(true)} ${cornerBlockerSql()}
      LEFT JOIN LATERAL (SELECT turn.ended_at,turn.status FROM agent_turns turn
        WHERE turn.room_id=c.id AND turn.agent_id IS DISTINCT FROM c.created_by
          AND COALESCE(turn.generation_id,'') NOT LIKE 'pending:%'
        ORDER BY turn.ended_at DESC NULLS LAST,turn.created_at DESC LIMIT 1) ended ON true
      CROSS JOIN LATERAL (SELECT GREATEST(c.created_at,
        (SELECT max(latest.created_at) FROM identities author CROSS JOIN LATERAL (
          SELECT message.created_at FROM messages message
          WHERE message.room_id=c.id AND message.author_id=author.id
            AND message.presentation='message' AND message.system_event IS NULL
          ORDER BY message.created_at DESC LIMIT 1
        ) latest WHERE author.kind='human' AND author.id<>'${SYSTEM_IDENTITY_ID}'),
        (SELECT max(released_at) FROM corner_merge_holds WHERE corner_id=c.id),
        (SELECT max(expires_at) FROM corner_owed WHERE corner_id=c.id AND expires_at<=now()),
        (SELECT max(ended_at) FROM (${cornerOwedAnswerTimesSql('c.id')}) answered_owed),
        (SELECT max(ended_at) FROM (${cornerReportAnswerTimesSql('c.id')}) answered_report)
      ) at OFFSET 0) boundary
      ) snapshot`;
}

export function cornerCanReportIdle(row: CornerIdleRow): boolean {
  return !row.suppressed && !row.worker_active && !row.reviewer_active && cornerRowState(row).state === 'idle';
}

/** Delivery and claim require the same idle start and absence of every idle disqualifier. */
export function currentIdleReportSql(command: string): string {
  return `EXISTS(SELECT 1 FROM (${cornerIdleSql(`(
    SELECT origin.id FROM rooms origin WHERE origin.archived_at IS NULL AND origin.id=CASE
      WHEN COALESCE(${command}.private_payload->>'originCornerId',${command}.private_payload->>'fromRoomId')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN COALESCE(${command}.private_payload->>'originCornerId',${command}.private_payload->>'fromRoomId')::uuid END)`)}) idle
    WHERE idle.idle_since=${command}.private_payload->>'idleSince'
      AND idle.idle_eligible)`;
}
