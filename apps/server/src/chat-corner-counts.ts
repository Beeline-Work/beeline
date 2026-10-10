import { deriveCornerState, type DerivedCornerState } from './corner-state.js';
import { cornerOwedLookupSql } from './corner-owed.js';
import { followsCornerSql } from './corner-follow.js';
import { visibleChatMessageSql } from './read-cursor.js';
import type { ChatListCorner, CornerLifecycleView } from '@beeline/api-contract/phone';

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
  /** `cornerOwedLookupSql`'s facts for this corner and viewer. */
  owed?: boolean | null;
  owed_viewer?: boolean | null;
  /** `viewerFollowsCornerSql`: the push Followed rule for this viewer. */
  follows_viewer?: boolean | null;
  /** `corner_facts.commissioned_by` is the viewer. */
  commissioned_viewer?: boolean | null;
};

/** The one corner state derivation for the Room list, its live frame and the Corners page. */
export function cornerRowState(row: CornerStateRow): DerivedCornerState {
  return deriveCornerState({
    archived: Boolean(row.archived_at),
    turnRunning: row.latest_turn_status === 'working',
    ...(row.workflow_state
      ? { run: { state: row.workflow_state, outcome: row.workflow_outcome ?? undefined } }
      : {}),
    lifecycle: row.lifecycle ?? undefined,
    ...(typeof row.owed === 'boolean' ? { owed: row.owed } : {}),
  });
}

/**
 * Mine: the viewer follows it (opened, requested, posted, steered or was
 * tagged), it owes them something, or they commissioned it.
 */
export function cornerRowMine(
  row: Pick<CornerStateRow, 'follows_viewer' | 'owed_viewer' | 'commissioned_viewer'>,
): boolean {
  return Boolean(row.follows_viewer || row.owed_viewer || row.commissioned_viewer);
}

/**
 * The open corners under `parentPredicate` (a condition on `c.parent_id`)
 * that `viewerExpr` belongs to, newest first, with the facts
 * `chatCornerCounts` reads.
 */
export function openCornerFactsSql(parentPredicate: string, viewerExpr: string): string {
  return `SELECT c.id,c.name,c.parent_id,c.created_at,c.archived_at,
      f.lifecycle,f.workflow_state,f.workflow_outcome,
      turn.status latest_turn_status,
      ${followsCornerSql('c', viewerExpr)} follows_viewer,
      (f.commissioned_by IS NOT NULL AND f.commissioned_by=${viewerExpr}) commissioned_viewer,
      lm.created_at latest_created_at,
      owed.owed,owed.owed_viewer,owed.attention
    FROM rooms c LEFT JOIN corner_facts f ON f.corner_id=c.id
    LEFT JOIN LATERAL (SELECT created_at FROM messages message WHERE message.room_id=c.id
      AND message.presentation IN ('message','system') AND ${visibleChatMessageSql('message')}
      ORDER BY created_at DESC,id DESC LIMIT 1) lm ON true
    LEFT JOIN LATERAL (SELECT status FROM agent_turns WHERE room_id=c.id
      ORDER BY created_at DESC LIMIT 1) turn ON true
    ${cornerOwedLookupSql('c', viewerExpr)}
    WHERE c.parent_id ${parentPredicate} AND c.archived_at IS NULL AND EXISTS (
      SELECT 1 FROM memberships corner_member WHERE corner_member.room_id=c.id
        AND corner_member.identity_id=${viewerExpr} AND corner_member.removed_at IS NULL)
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

/**
 * Same state derivation as the Corners page, batched for a Workspace deck.
 * Rows arrive newest first. Counts are exact; the list keeps every Mine
 * corner and fills to `OPEN_CORNER_PREVIEW` with the newest others.
 */
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
