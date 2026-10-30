import { cornerReviewerSql, cornerReviewerFallbacksSql } from './corner-reviewer.js';
import { createHash } from 'node:crypto';
import { deriveCornerState, type DerivedCornerState } from './corner-state.js';
import { cornerOwedLookupSql } from './corner-owed.js';
import { followsCornerSql } from './corner-follow.js';
import { visibleChatMessageSql } from './read-cursor.js';
import type {
  ChatListCorner,
  CornerLifecycleView,
  CornerStateReason,
} from '@beeline/api-contract/phone';

/** Open corners a Room row lists beyond the viewer's own; every Mine corner is listed. */
export const OPEN_CORNER_PREVIEW = 8;

/** The facts every corner row derives its state and Mine flag from. */
export type CornerStateRow = {
  waiting_kind?: 'message' | 'merge-hold' | 'report' | null;
  waiting_person_name?: string | null;
  archived_at: Date | null;
  lifecycle: CornerLifecycleView | null;
  /** The corner lifecycle's projected state (`corner_facts.workflow_state`). */
  workflow_state?: string | null;
  workflow_outcome?: string | null;
  latest_turn_status: string | null;
  worker_active?: boolean;
  last_turn_ended_at?: Date | null;
  ci_started_at?: Date | null;
  reviewer_active?: boolean;
  /** `cornerScheduledWaitSql`: an agent schedule will still wake the corner. */
  scheduled_wait?: boolean | null;
  blocking?: boolean;
  waiting_item_id?: string | null;
  waiting_reason?: CornerStateReason | null;
  waiting_person_id?: string | null;
  waiting_since?: Date | null;
  /** Selected blocker is a report addressed to the agent commander. */
  agent_commander?: boolean | null;
  /** Another blocker in the same corner is addressed to a person; merge holds do not count. */
  human_blocker?: boolean | null;
  /** `cornerOwedLookupSql`'s facts for this corner and viewer. */
  owed?: boolean | null;
  owed_viewer?: boolean | null;
  /** `followsCornerSql`: the push Followed rule for this viewer. */
  follows_viewer?: boolean | null;
};

export function cornerRowState(row: CornerStateRow): DerivedCornerState {
  const agentCommander = row.agent_commander === true && row.human_blocker !== true;
  return deriveCornerState({
    archived: Boolean(row.archived_at),
    turnRunning: row.worker_active ?? row.latest_turn_status === 'working',
    reviewerActive: row.reviewer_active,
    ...(row.scheduled_wait ? { scheduledWait: true } : {}),
    ...(row.workflow_state
      ? { run: { state: row.workflow_state, outcome: row.workflow_outcome ?? undefined } }
      : {}),
    lifecycle: row.lifecycle ?? undefined,
    owed: row.blocking ?? false,
    ...(agentCommander ? { agentCommanderReport: true } : {}),
    ...(row.waiting_item_id && row.waiting_reason
      ? {
          blocker: {
            reason: row.waiting_reason,
            ...{
              itemId:
                row.waiting_kind === 'report'
                  ? createHash('sha256')
                      .update(`agent-command-card:${row.waiting_item_id}`)
                      .digest('hex')
                  : row.waiting_kind === 'merge-hold'
                    ? createHash('sha256')
                        .update(`corner-hold:${row.waiting_item_id}`)
                        .digest('hex')
                    : row.waiting_item_id,
            },
            ...(row.waiting_kind
              ? {
                  blocker: {
                    kind: row.waiting_kind,
                    ...(row.waiting_person_id ? { personId: row.waiting_person_id } : {}),
                    ...(row.waiting_person_name ? { personName: row.waiting_person_name } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  });
}

/** Mine is followed or owed to this viewer. */
export function cornerRowMine(
  row: Pick<CornerStateRow, 'follows_viewer' | 'owed_viewer'>,
): boolean {
  return Boolean(row.follows_viewer || row.owed_viewer);
}

/** An unexhausted agent schedule in `corner` that will still run. */
export function cornerScheduledWaitSql(corner: string): string {
  return `EXISTS(SELECT 1 FROM agent_schedules schedule WHERE schedule.room_id=${corner}.id
      AND schedule.next_run_at>now()
      AND (schedule.max_runs IS NULL OR schedule.run_count<schedule.max_runs))`;
}

/** Shared corner facts for `FROM rooms c`; `member` checks the viewer's membership. */
export function cornerFactsSql(viewerExpr: string): {
  columns: string;
  joins: string;
  member: string;
} {
  return {
    columns: `f.lifecycle,f.workflow_state,f.workflow_outcome,
      activity.worker_active,activity.reviewer_active,
      span.last_turn_ended_at,span.ci_started_at,
      ${cornerScheduledWaitSql('c')} scheduled_wait,
      blocker.item_id IS NOT NULL blocking,blocker.item_id waiting_item_id,blocker.reason waiting_reason,
      blocker.kind waiting_kind,blocker.person_name waiting_person_name,
      blocker.person_id waiting_person_id,blocker.created_at waiting_since,
      blocker.agent_commander,blocker.human_blocker,
      turn.status latest_turn_status,turn.created_at latest_turn_created_at,
      lm.created_at latest_created_at,
      ${followsCornerSql('c', viewerExpr)} follows_viewer,
      owed.owed,owed.owed_viewer,owed.attention`,
    joins: `LEFT JOIN corner_facts f ON f.corner_id=c.id
    ${cornerWorkSql()}
    LEFT JOIN corner_attention_spans span ON span.corner_id=c.id
    ${cornerBlockerSql()}
    LEFT JOIN LATERAL (SELECT * FROM messages message WHERE message.room_id=c.id
      AND message.presentation IN ('message','system') AND ${visibleChatMessageSql('message')}
      ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
    LEFT JOIN LATERAL (SELECT status,created_at FROM agent_turns WHERE room_id=c.id
      ORDER BY created_at DESC LIMIT 1) turn ON true
    ${cornerOwedLookupSql('c', viewerExpr)}`,
    member: `EXISTS (SELECT 1 FROM effective_memberships corner_member WHERE corner_member.room_id=c.id
      AND corner_member.identity_id=${viewerExpr} AND corner_member.removed_at IS NULL)`,
  };
}

/** A running turn retains the review role recorded by its dispatch. */
export function cornerWorkSql(ignoreCommander = false): string {
  const reviewerTurn = `(t.agent_id=ANY(array_remove(ARRAY[${cornerReviewerSql('c')}]||${cornerReviewerFallbacksSql('c')},NULL))
    OR EXISTS(SELECT 1 FROM agent_commands dispatched
      LEFT JOIN messages source ON source.id=dispatched.source_message_id
      WHERE dispatched.room_id=t.room_id AND dispatched.agent_id=t.agent_id
        AND dispatched.turn_request_id=t.request_id
        AND (dispatched.reason='corner_review_dispatch'
          OR (dispatched.reason='subscribed_event' AND source.system_event->>'kind'='check-passed'
            AND source.system_event->'object'->>'headSha'=f.lifecycle->'pr'->>'headSha'))))`;
  return `LEFT JOIN rooms parent ON parent.id=c.parent_id
    LEFT JOIN LATERAL (WITH turns AS MATERIALIZED (SELECT ${reviewerTurn} review,
        COALESCE(t.generation_id,'') LIKE 'pending:%' pending
        FROM agent_turns t WHERE t.room_id=c.id AND t.status='working'
          ${ignoreCommander ? 'AND t.agent_id IS DISTINCT FROM c.created_by' : ''}
          AND (COALESCE(t.generation_id,'') NOT LIKE 'pending:%'
            OR t.created_at>now()-interval '30 seconds'))
      SELECT COALESCE(bool_or(pending OR NOT review),false) worker_active,
        COALESCE(bool_or(NOT pending AND review),false) reviewer_active FROM turns
    ) activity ON true`;
}

/**
 * Blocking people and recorded commanders. Display picks the oldest; reminders retain newest-first selection.
 * Merge holds rank after every other blocker, so a hold is selected only when nothing else is open.
 */
export function cornerBlockerSql(sourcePredicate = 'true', newestFirst = false): string {
  const direction = newestFirst ? 'DESC' : 'ASC';
  return `LEFT JOIN LATERAL (
    SELECT ranked.* FROM (
      SELECT blockers.*,person.name person_name,
        bool_or(NOT blockers.agent_commander AND blockers.kind<>'merge-hold') OVER () human_blocker
      FROM (
      SELECT owed.message_id item_id,owed.person_id,owed.created_at,
        CASE WHEN item.card_type IN ('squire-approval','permission','grant-request') THEN 'approve'
          WHEN item.card_type IN ('connector-offer','app-sign-in','agent-sign-in') THEN 'connect'
          ELSE 'question' END reason,'message'::text kind,false agent_commander
      FROM corner_owed owed
      JOIN messages item ON item.id=owed.message_id
      JOIN memberships current_member ON current_member.room_id=c.parent_id
        AND current_member.identity_id=owed.person_id AND current_member.removed_at IS NULL
      WHERE owed.corner_id=c.id AND owed.blocking
        AND (owed.expires_at IS NULL OR owed.expires_at>now())
      UNION ALL
      SELECT COALESCE(report.message_id,report.report_id),report.person_id,report.created_at,'question',
        CASE WHEN report.return_room_id=c.id AND report.message_id IS NOT NULL THEN 'message'
          ELSE 'report' END,recipient.kind='agent' FROM corner_report_blockers report
      JOIN identities recipient ON recipient.id=report.person_id
        AND (recipient.kind='human' OR report.person_id=report.commander_id)
      WHERE report.corner_id=c.id
      UNION ALL
      SELECT hold.id::text,hold.actor_id,hold.set_at,'approve','merge-hold',false FROM corner_merge_holds hold
      JOIN identities holder ON holder.id=hold.actor_id AND holder.kind='human'
      WHERE hold.corner_id=c.id AND hold.released_at IS NULL
    ) blockers LEFT JOIN identities person ON person.id=blockers.person_id
    WHERE ${sourcePredicate}
    ) ranked ORDER BY ranked.kind='merge-hold',ranked.created_at ${direction},ranked.item_id ${direction},ranked.person_id LIMIT 1
  ) blocker ON true`;
}

/** Open member corners under `c.parent_id`, newest first. */
export function openCornerFactsSql(parentPredicate: string, viewerExpr: string): string {
  const facts = cornerFactsSql(viewerExpr);
  return `SELECT c.id,c.name,c.parent_id,c.created_at,c.archived_at,${facts.columns}
    FROM rooms c ${facts.joins}
    WHERE c.parent_id ${parentPredicate} AND c.archived_at IS NULL AND ${facts.member}
    ORDER BY c.created_at DESC,c.id DESC`;
}

/** A Room or any corner under it has a pending permission. */
export function roomNeedsYouSql(room: string): string {
  return `EXISTS(SELECT 1 FROM permission_authority p
    WHERE p.status='pending' AND (p.room_id=${room}.id OR p.room_id IN
      (SELECT id FROM rooms WHERE parent_id=${room}.id)))`;
}

/** A Room or any open corner under it has a working turn. */
export function roomWorkingSql(room: string): string {
  // Bound each turn lookup by Room before testing status. The OR/IN form
  // otherwise chooses a full turn-table scan once per visible Room.
  return `EXISTS(SELECT 1 FROM (
    SELECT ${room}.id UNION ALL
    SELECT id FROM rooms WHERE parent_id=${room}.id AND archived_at IS NULL
  ) scope(id) CROSS JOIN LATERAL (
    SELECT 1 FROM agent_turns t WHERE t.room_id=scope.id AND t.status='working'
    LIMIT 1 OFFSET 0
  ) working)`;
}

/** The agent named on the newest pending permission card in a Room or its corners. */
export function roomAttentionActorSql(room: string): string {
  return `(SELECT agent.name
    FROM permission_authority permission
    LEFT JOIN LATERAL (
      SELECT message.card FROM messages message
      WHERE message.room_id=permission.room_id AND message.card_type='permission'
        AND message.card->>'permissionId'=permission.permission_id
      ORDER BY message.created_at DESC,message.id DESC LIMIT 1
    ) permission_card ON true
    LEFT JOIN identities agent ON agent.id=permission_card.card->'agent'->>'pubkey'
    WHERE permission.status='pending'
      AND (permission.room_id=${room}.id OR permission.room_id IN (
        SELECT id FROM rooms WHERE parent_id=${room}.id
      ))
    ORDER BY permission.updated_at DESC LIMIT 1)`;
}

export type ChatCornerSummary = {
  cornerCount: number;
  waitingCornerCount: number;
  mineCornerCount: number;
  openCorners: ChatListCorner[];
};

/** Count every corner; preview every Mine corner and the newest others. */
export function chatCornerCounts(
  rows: readonly (CornerStateRow & {
    id: string;
    name: string;
    parent_id: string;
    latest_created_at?: Date | null;
    attention?: boolean | null;
  })[],
): Map<string, ChatCornerSummary> {
  const counts = new Map<string, ChatCornerSummary>();
  for (const row of rows) {
    const { state, reason, itemId, blocker } = cornerRowState(row);
    if (state === 'archived') continue;
    const count = counts.get(row.parent_id) ?? {
      cornerCount: 0,
      waitingCornerCount: 0,
      mineCornerCount: 0,
      openCorners: [],
    };
    counts.set(row.parent_id, count);
    count.cornerCount += 1;
    if (state === 'waiting') count.waitingCornerCount += 1;
    const mine = cornerRowMine(row);
    if (mine) count.mineCornerCount += 1;
    // The viewer's corner handing back is activity in its Room.
    const waitingSince =
      mine && state === 'waiting' && row.latest_created_at
        ? Math.floor(row.latest_created_at.getTime() / 1000)
        : undefined;
    count.openCorners.push({
      id: row.id,
      name: row.name,
      state,
      ...(reason ? { reason } : {}),
      ...(blocker ? { blocker } : {}),
      ...(itemId ? { itemId } : {}),
      ...(mine ? { mine: true } : {}),
      ...(waitingSince !== undefined ? { waitingSince } : {}),
      // Owed to the viewer and not seen since: only this opens their dropdown.
      ...(row.attention && state === 'waiting' ? { attention: true as const } : {}),
    });
  }
  for (const count of counts.values()) {
    let others = Math.max(0, OPEN_CORNER_PREVIEW - count.mineCornerCount);
    count.openCorners = count.openCorners.filter((corner) => corner.mine || others-- > 0);
  }
  return counts;
}

/** One row of `openCornerFactsSql`. */
export type OpenCornerFactsRow = CornerStateRow & {
  id: string;
  name: string;
  parent_id: string;
  created_at: Date;
  latest_created_at: Date | null;
  attention: boolean | null;
};
