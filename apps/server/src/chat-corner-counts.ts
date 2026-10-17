import { deriveCornerState, type DerivedCornerState } from './corner-state.js';
import { cornerOwedLookupSql } from './corner-owed.js';
import { followsCornerSql } from './corner-follow.js';
import { visibleChatMessageSql } from './read-cursor.js';
import type { ChatListCorner, CornerLifecycleView } from '@beeline/api-contract/phone';
import { cornerImplementerSql } from './corner-worker.js';

/** Open corners a Room row lists beyond the viewer's own; every Mine corner is listed. */
export const OPEN_CORNER_PREVIEW = 8;

/** The facts every corner row derives its state and Mine flag from. */
export type CornerStateRow = {
  archived_at: Date | null;
  lifecycle: CornerLifecycleView | null;
  /** The corner lifecycle's projected state (`corner_facts.workflow_state`). */
  workflow_state?: string | null;
  workflow_outcome?: string | null;
  latest_turn_status: string | null;
  worker_active?: boolean;
  reviewer_active?: boolean;
  blocking?: boolean;
  waiting_item_id?: string | null;
  waiting_person_id?: string | null;
  waiting_since?: Date | null;
  /** `cornerOwedLookupSql`'s facts for this corner and viewer. */
  owed?: boolean | null;
  owed_viewer?: boolean | null;
  /** `followsCornerSql`: the push Followed rule for this viewer. */
  follows_viewer?: boolean | null;
};

/** The one corner state derivation for the Room list, its live frame and the Corners page. */
export function cornerRowState(row: CornerStateRow): DerivedCornerState {
  return deriveCornerState({
    archived: Boolean(row.archived_at),
    turnRunning: row.worker_active ?? row.latest_turn_status === 'working',
    reviewerActive: row.reviewer_active,
    ...(row.workflow_state
      ? { run: { state: row.workflow_state, outcome: row.workflow_outcome ?? undefined } }
      : {}),
    lifecycle: row.lifecycle ?? undefined,
    owed: row.blocking ?? row.owed ?? false,
  });
}

/** Mine is followed or owed to this viewer. */
export function cornerRowMine(row: Pick<CornerStateRow, 'follows_viewer' | 'owed_viewer'>): boolean {
  return Boolean(row.follows_viewer || row.owed_viewer);
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
      blocker.item_id IS NOT NULL blocking,blocker.item_id waiting_item_id,
      blocker.person_id waiting_person_id,blocker.created_at waiting_since,
      turn.status latest_turn_status,turn.created_at latest_turn_created_at,
      lm.created_at latest_created_at,
      ${followsCornerSql('c', viewerExpr)} follows_viewer,
      owed.owed,owed.owed_viewer,owed.attention`,
    joins: `LEFT JOIN corner_facts f ON f.corner_id=c.id
    ${cornerWorkSql()}
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

/** Worker and reviewer activity from their complete command queues and running receipts. */
export function cornerWorkSql(): string {
  return `LEFT JOIN rooms parent ON parent.id=c.parent_id
    LEFT JOIN LATERAL (SELECT
      EXISTS(SELECT 1 FROM agent_turns t WHERE t.room_id=c.id AND t.status='working'
        AND t.agent_id=${cornerImplementerSql('f', 'c')}) OR
      EXISTS(SELECT 1 FROM agent_commands command WHERE command.room_id=c.id
        AND command.agent_id=${cornerImplementerSql('f', 'c')}
        AND command.state IN ('pending','claimed') AND command.action<>'stop') worker_active,
      EXISTS(SELECT 1 FROM agent_turns t WHERE t.room_id=c.id AND t.status='working'
        AND t.agent_id=ANY(ARRAY[parent.reviewer_agent_id]||parent.reviewer_fallback_ids)) OR
      EXISTS(SELECT 1 FROM agent_commands command WHERE command.room_id=c.id
        AND command.agent_id=ANY(ARRAY[parent.reviewer_agent_id]||parent.reviewer_fallback_ids)
        AND command.state IN ('pending','claimed') AND command.action<>'stop') reviewer_active
    ) activity ON true`;
}

/** Indexed unanswered requests and active human holds; ordinary mentions are not blockers. */
export function cornerBlockerSql(sourcePredicate = 'true'): string {
  return `LEFT JOIN LATERAL (
    SELECT item_id,person_id,created_at FROM (
      SELECT owed.message_id item_id,owed.person_id,owed.created_at
      FROM corner_owed owed
      JOIN memberships current_member ON current_member.room_id=c.parent_id
        AND current_member.identity_id=owed.person_id AND current_member.removed_at IS NULL
      WHERE owed.corner_id=c.id AND owed.blocking
        AND (owed.expires_at IS NULL OR owed.expires_at>now())
      UNION ALL
      SELECT hold.id::text,hold.actor_id,hold.set_at FROM corner_merge_holds hold
      JOIN identities holder ON holder.id=hold.actor_id AND holder.kind='human'
      JOIN effective_memberships holder_member ON holder_member.room_id=c.id
        AND holder_member.identity_id=hold.actor_id AND holder_member.removed_at IS NULL
      WHERE hold.corner_id=c.id AND hold.released_at IS NULL
    ) blockers WHERE ${sourcePredicate} ORDER BY created_at DESC,item_id DESC,person_id LIMIT 1
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
  return `EXISTS(SELECT 1 FROM agent_turns t
    WHERE t.status='working' AND (t.room_id=${room}.id OR t.room_id IN
      (SELECT id FROM rooms WHERE parent_id=${room}.id AND archived_at IS NULL)))`;
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
    const { state } = cornerRowState(row);
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
