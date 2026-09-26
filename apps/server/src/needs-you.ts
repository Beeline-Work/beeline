import type { NeedsYouItemView, RoomViewIdentity } from '@beeline/api-contract/phone';
import { AGENT_GRANT_VERBS, type AgentGrantKind } from '@beeline/api-contract/agent-grants';
import type { SqlDatabase } from './database.js';
import { tagsKnownIdentitySql } from './message-mentions.js';

/**
 * The "Needs you" tray, owned here and nowhere else.
 *
 * A message needs a person when BOTH hold: it tags them (the ordinary live
 * mention reading, `tagsKnownIdentitySql`), AND it asks — its text ends with a
 * question mark, or it contains one of the words below. Humans and agents are
 * read by the same rule; nothing is classified and nothing is stored about
 * the message itself. A pending agent-grant card the person can decide is a
 * cell too, as it stands.
 *
 * A cell leaves the tray when the person taps or dismisses it
 * (`needs_you_marks.cleared_at`), replies anywhere in that Room or corner
 * after it, 24 hours after they first saw it on any device
 * (`needs_you_marks.first_seen_at`), or — for a grant card — once it is
 * decided. Grant cards never expire.
 */
export const NEEDS_YOU_TRIGGER_WORDS = ['please', 'approve', 'feedback'] as const;
/** A cell's life, counted from the first time the person saw it in the tray. */
export const NEEDS_YOU_EXPIRY_HOURS = 24;
/**
 * How far back a tagged message is considered at all — a deliberate bound for
 * launch and backfill, not part of the approved expiry rule. The 24-hour clock
 * only starts once a cell is seen, so without this window the first tray open
 * (or a person back after months) would pull every tagged question in the
 * Workspace's history. Inside the window, the 24-hour clock still starts only
 * on first sight.
 */
const NEEDS_YOU_LOOKBACK_DAYS = 7;
/** Roughly two lines of a phone cell; the desktop list pane is the same width. */
export const NEEDS_YOU_TEXT_MAX = 80;
/** A safety cap on qualifying rows only: `askSql` runs before it, so no near-miss can crowd out an ask. */
const CANDIDATE_LIMIT = 500;

const TRIGGER_WORD = new RegExp(
  `(^|[^\\p{L}\\p{N}_])(${NEEDS_YOU_TRIGGER_WORDS.join('|')})(?=$|[^\\p{L}\\p{N}_])`,
  'iu',
);
/** A closing question mark, allowing only ordinary trailing whitespace — `askSql` reads the same. */
const ENDS_WITH_QUESTION = /\?[ \t\n\r\f\v]*$/;

/** The ask half of the rule: ends with `?`, or says please / approve / feedback as a word. */
export function isNeedsYouAsk(text: string): boolean {
  return ENDS_WITH_QUESTION.test(text) || TRIGGER_WORD.test(text);
}

/**
 * `isNeedsYouAsk` in SQL, applied BEFORE the candidate limit so the limit only
 * ever counts messages that really ask. The two readings must agree
 * (`needs-you.test.ts` holds them to one table); the TypeScript twin still
 * re-checks every row the query returns.
 */
export function askSql(textExpr: string): string {
  return `(${textExpr} ~ '\\?[ \\t\\n\\r\\f\\v]*$'
    OR ${textExpr} ~* '(^|[^[:alnum:]_])(${NEEDS_YOU_TRIGGER_WORDS.join('|')})($|[^[:alnum:]_])')`;
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * The sentence that made the message an ask: the closing question when the
 * message ends with `?`, otherwise the last sentence holding a trigger word.
 */
export function needsYouSentence(text: string): string {
  const all = sentences(text);
  const last = all.at(-1) ?? text.trim();
  if (text.trim().endsWith('?')) return last;
  for (let index = all.length - 1; index >= 0; index -= 1)
    if (TRIGGER_WORD.test(all[index]!)) return all[index]!;
  return last;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Remove the tags that addressed the reader: every cell was addressed to them,
 * so repeating their own handle in each row says nothing. Other people's
 * handles stay — "ask @hoots to…" still needs them.
 */
export function withoutReaderTags(sentence: string, readerHandle: string | null): string {
  const handles = ['channel', ...(readerHandle ? [readerHandle.trim().replace(/^@/, '')] : [])]
    .filter(Boolean)
    .map(escapeRegExp);
  const tag = new RegExp(
    `(^|[^\\p{L}\\p{N}_.-])@(?:${handles.join('|')})(?=[.-]*(?:$|[^\\p{L}\\p{N}_.-]))`,
    'giu',
  );
  const stripped = sentence
    .replace(tag, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:—–-]+/u, '')
    .trim();
  return stripped || sentence.trim();
}

/**
 * Plain string shortening: when the sentence is too long, keep its END — the
 * ask is usually there — and lead with `…`. The cut moves forward to the next
 * word boundary when one is close, so no word is shown half.
 */
export function keepEnd(text: string, max = NEEDS_YOU_TEXT_MAX): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  let tail = characters.slice(characters.length - (max - 2)).join('');
  const boundary = tail.search(/\s/);
  if (boundary >= 0 && boundary <= 20) tail = tail.slice(boundary + 1);
  return `… ${tail.trimStart()}`;
}

/** The whole row text for one tagged message, as the reader sees it. */
export function needsYouRowText(message: string, readerHandle: string | null): string {
  return keepEnd(withoutReaderTags(needsYouSentence(message), readerHandle));
}

type GrantCardEntry = { grantId?: string; kind?: AgentGrantKind; target?: string };

type Row = {
  message_id: string;
  room_id: string;
  room_name: string;
  room_kind: 'room' | 'corner' | 'direct';
  text: string;
  card: { agent?: { name?: string }; grants?: GrantCardEntry[] } | null;
  approval: boolean;
  pending_grant_ids: string[] | null;
  created_at: Date;
  first_seen_at: Date | null;
  author_id: string | null;
  author_kind: 'human' | 'agent' | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar: string | null;
  author_face: string | null;
};

const ROW_COLUMNS = `
  m.id message_id,m.room_id,m.text,m.card,m.created_at,mark.first_seen_at,
  CASE WHEN room.direct_participants IS NOT NULL THEN COALESCE((
      SELECT peer.name FROM memberships peer_member
      JOIN identities peer ON peer.id=peer_member.identity_id
      WHERE peer_member.room_id=room.id AND peer_member.identity_id<>$2
        AND peer_member.removed_at IS NULL
      ORDER BY peer_member.joined_at LIMIT 1
    ),room.name) ELSE room.name END room_name,
  CASE WHEN room.direct_participants IS NOT NULL THEN 'direct'
    WHEN room.parent_id IS NOT NULL THEN 'corner' ELSE 'room' END room_kind,
  author.id author_id,author.kind author_kind,author.name author_name,
  author.handle author_handle,author.avatar author_avatar,author.face_id author_face`;

const VIEWER_ROOMS = `
  viewer_rooms AS (
    SELECT room.* FROM memberships room_member
    JOIN rooms room ON room.id=room_member.room_id
    WHERE room_member.identity_id=$2 AND room_member.removed_at IS NULL
      AND room.workspace_id=$1 AND room.archived_at IS NULL
  )`;

/**
 * Every current cell for one person in one Workspace, newest first, with the
 * ids nobody has started a clock for yet. Pure read: `readNeedsYou` starts
 * the clocks for what it shows, and the badge count starts none.
 */
export async function needsYouItems(
  database: SqlDatabase,
  workspaceId: string,
  viewerId: string,
  toIdentity: (row: {
    id: string;
    kind: 'human' | 'agent';
    name: string;
    handle: string | null;
    avatar: string | null;
    face_id: string | null;
  }) => RoomViewIdentity,
): Promise<{ items: NeedsYouItemView[]; unseen: string[] }> {
  const viewer = (
    await database.query<{ handle: string | null }>(`SELECT handle FROM identities WHERE id=$1`, [
      viewerId,
    ])
  ).rows[0];
  if (!viewer) return { items: [], unseen: [] };
  const [tagged, approvals] = await Promise.all([
    database.query<Row>(
      `WITH ${VIEWER_ROOMS}
       SELECT ${ROW_COLUMNS},false approval,NULL::text[] pending_grant_ids
       FROM viewer_rooms room
       JOIN messages m ON m.room_id=room.id
       JOIN identities viewer ON viewer.id=$2
       LEFT JOIN identities author ON author.id=m.author_id
       LEFT JOIN needs_you_marks mark ON mark.identity_id=$2 AND mark.message_id=m.id
       WHERE m.presentation='message' AND m.deleted_at IS NULL AND m.author_id<>$2
         AND m.created_at>now()-interval '${NEEDS_YOU_LOOKBACK_DAYS} days'
         AND mark.cleared_at IS NULL
         AND (mark.first_seen_at IS NULL
           OR mark.first_seen_at>now()-interval '${NEEDS_YOU_EXPIRY_HOURS} hours')
         AND ${askSql('m.text')}
         AND ${tagsKnownIdentitySql('m', 'viewer.id', 'viewer.handle', 'viewer.kind')}
         AND NOT EXISTS (
           SELECT 1 FROM messages reply
           WHERE reply.room_id=m.room_id AND reply.author_id=$2
             AND reply.presentation='message' AND reply.deleted_at IS NULL
             AND reply.created_at>m.created_at
         )
       ORDER BY m.created_at DESC,m.id DESC
       LIMIT ${CANDIDATE_LIMIT}`,
      [workspaceId, viewerId],
    ),
    // Driven from the few pending grants rather than from the transcript, so
    // an old undecided card costs nothing to find. The decider rule is
    // `requireGrantAuthority`'s: the agent's owner for a personal resource, a
    // Workspace owner/admin for a repository.
    database.query<Row>(
      `WITH ${VIEWER_ROOMS},
       decidable AS (
         SELECT grant_row.id::text grant_id FROM agent_grants grant_row
         JOIN agents agent ON agent.agent_id=grant_row.agent_id
         WHERE grant_row.workspace_id=$1 AND grant_row.status='pending'
           AND CASE WHEN grant_row.kind='repository' THEN EXISTS (
               SELECT 1 FROM memberships manager
               WHERE manager.workspace_id=$1 AND manager.room_id IS NULL
                 AND manager.identity_id=$2 AND manager.removed_at IS NULL
                 AND manager.role IN ('owner','admin'))
             ELSE agent.owner_id=$2 END
       )
       SELECT ${ROW_COLUMNS},true approval,
         ARRAY(SELECT entry->>'grantId' FROM jsonb_array_elements(m.card->'grants') entry
           WHERE entry->>'grantId' IN (SELECT grant_id FROM decidable)) pending_grant_ids
       FROM viewer_rooms room
       JOIN messages m ON m.room_id=room.id AND m.card_type='grant-request'
       LEFT JOIN identities author ON author.id=m.author_id
       LEFT JOIN needs_you_marks mark ON mark.identity_id=$2 AND mark.message_id=m.id
       WHERE EXISTS (SELECT 1 FROM decidable)
         AND m.deleted_at IS NULL AND mark.cleared_at IS NULL
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(m.card->'grants') entry
           WHERE entry->>'grantId' IN (SELECT grant_id FROM decidable)
         )
       ORDER BY m.created_at DESC,m.id DESC`,
      [workspaceId, viewerId],
    ),
  ]);
  const rows = [...tagged.rows.filter((row) => isNeedsYouAsk(row.text)), ...approvals.rows].sort(
    (left, right) =>
      right.created_at.getTime() - left.created_at.getTime() ||
      (right.message_id < left.message_id ? -1 : 1),
  );
  const items = rows.map((row): NeedsYouItemView => {
    const text = row.approval
      ? approvalText(row.card, row.pending_grant_ids ?? [])
      : needsYouRowText(row.text, viewer.handle);
    return {
      messageId: row.message_id,
      workspaceId,
      roomId: row.room_id,
      roomName: row.room_name,
      roomKind: row.room_kind,
      text,
      createdAt: Math.floor(row.created_at.getTime() / 1000),
      ...(!row.approval && row.first_seen_at
        ? { expiresAt: needsYouExpiresAt(row.first_seen_at) }
        : {}),
      ...(row.author_id && row.author_kind && row.author_name
        ? {
            author: toIdentity({
              id: row.author_id,
              kind: row.author_kind,
              name: row.author_name,
              handle: row.author_handle,
              avatar: row.author_avatar,
              face_id: row.author_face,
            }),
          }
        : {}),
    };
  });
  return {
    items,
    // A grant card has no clock: it stays until someone decides it.
    unseen: rows.filter((row) => !row.approval && !row.first_seen_at).map((row) => row.message_id),
  };
}

export function needsYouExpiresAt(firstSeenAt: Date): number {
  return Math.floor(firstSeenAt.getTime() / 1000) + NEEDS_YOU_EXPIRY_HOURS * 60 * 60;
}

/** `Allow Hoots to run gh pr checks`, plus how many more asks the card holds. */
function approvalText(card: Row['card'], pendingGrantIds: readonly string[]): string {
  const pending = (card?.grants ?? []).filter(
    (entry) => entry.grantId && pendingGrantIds.includes(entry.grantId),
  );
  const first = pending[0];
  const agent = card?.agent?.name?.trim() || 'an agent';
  const ask =
    first?.kind && first.target
      ? `Allow ${agent} to ${AGENT_GRANT_VERBS[first.kind] ?? 'use'} ${first.target}`
      : `Allow ${agent} access`;
  return keepEnd(pending.length > 1 ? `${ask} and ${pending.length - 1} more` : ask);
}
