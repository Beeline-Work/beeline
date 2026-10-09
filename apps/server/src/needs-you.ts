import {
  AGENT_SIGN_IN_SERVICE_LABELS,
  CHOICE_CARD_TYPE,
  type AgentSignInHarness,
  type NeedsYouApprovalKind,
  type NeedsYouApprovalView,
  type NeedsYouItemView,
  type RoomViewIdentity,
} from '@beeline/api-contract/phone';
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
 * the message itself. Every pending approval card the person can decide is a
 * cell too (`APPROVAL_QUERIES`), shown as text (`NeedsYouApprovalView`).
 *
 * A question leaves the tray when the person taps or dismisses it
 * (`needs_you_marks.cleared_at`), replies anywhere in that Room or corner
 * after it, or 24 hours after they first saw it on any device
 * (`needs_you_marks.first_seen_at`). An approval leaves only when it is
 * decided, expires or closes; opening it does not clear it.
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

type GrantCardEntry = { grantId?: string; kind?: AgentGrantKind; target?: string; reason?: string };

/** The raw card fields the approval rows read; every kind's card is a subset. */
type ApprovalCard = {
  agent?: { name?: string; pubkey?: string };
  requester?: { name?: string; pubkey?: string };
  grants?: GrantCardEntry[];
  repository?: string;
  tool?: string;
  purpose?: string;
  title?: string;
  detail?: string;
  linkKind?: 'approval' | 'passkey' | 'vouch';
  prompt?: string;
  options?: { label?: string }[];
  connectorName?: string;
  reason?: string;
  agentName?: string;
  source?: string;
  harness?: AgentSignInHarness;
  name?: string;
};

type Row = {
  message_id: string;
  room_id: string;
  room_name: string;
  room_kind: 'room' | 'corner' | 'direct';
  parent_room_name: string | null;
  text: string;
  card: ApprovalCard | null;
  approval_kind: NeedsYouApprovalKind | null;
  approval_expires_at: Date | null;
  pending_grant_ids: string[] | null;
  actor_name: string | null;
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
  (SELECT parent.name FROM rooms parent WHERE parent.id=room.parent_id) parent_room_name,
  author.id author_id,author.kind author_kind,author.name author_name,
  author.handle author_handle,author.avatar author_avatar,author.face_id author_face`;

const VIEWER_ROOMS = `
  viewer_rooms AS (
    SELECT room.* FROM memberships room_member
    JOIN rooms room ON room.id=room_member.room_id
    WHERE room_member.identity_id=$2 AND room_member.removed_at IS NULL
      AND room.workspace_id=$1 AND room.archived_at IS NULL
  )`;

/** The viewer ($2) manages the Workspace ($1). */
const VIEWER_MANAGES_WORKSPACE = `EXISTS (
  SELECT 1 FROM memberships manager
  WHERE manager.workspace_id=$1 AND manager.room_id IS NULL AND manager.identity_id=$2
    AND manager.removed_at IS NULL AND manager.role IN ('owner','admin'))`;

const APPROVAL_FROM = (
  kind: NeedsYouApprovalKind,
  expiresAt = 'NULL::timestamptz',
  actorName = 'NULL::text',
) => `
  SELECT ${ROW_COLUMNS},'${kind}' approval_kind,${expiresAt} approval_expires_at,
    NULL::text[] pending_grant_ids,${actorName} actor_name
  FROM viewer_rooms room`;

const APPROVAL_JOINS = `
  LEFT JOIN identities author ON author.id=m.author_id
  LEFT JOIN needs_you_marks mark ON mark.identity_id=$2 AND mark.message_id=m.id`;

/**
 * One query per approval kind, each driven from that kind's pending rows and
 * filtered by the rule the decide operation itself enforces, so the tray
 * never offers a card the viewer cannot decide. Cards with no Beeline-side
 * state (sign-in, Trusty Squire) are read from the lookback window.
 */
const APPROVAL_QUERIES: readonly string[] = [
  // Driven from the few pending grants rather than from the transcript, so
  // an old undecided card costs nothing to find. The decider rule is
  // `requireGrantAuthority`'s: the agent's owner for a personal resource, a
  // Workspace owner/admin for a repository.
  `WITH ${VIEWER_ROOMS},
   decidable AS (
     SELECT grant_row.id::text grant_id FROM agent_grants grant_row
     WHERE grant_row.workspace_id=$1 AND grant_row.status='pending'
       AND ${grantDecidedBySql('grant_row', '$2')}
   )
   SELECT ${ROW_COLUMNS},'grant' approval_kind,NULL::timestamptz approval_expires_at,
     NULL::text actor_name,
     ARRAY(SELECT entry->>'grantId' FROM jsonb_array_elements(m.card->'grants') entry
       WHERE entry->>'grantId' IN (SELECT grant_id FROM decidable)) pending_grant_ids
   FROM viewer_rooms room
   JOIN messages m ON m.room_id=room.id AND m.card_type='grant-request'
   ${APPROVAL_JOINS}
   WHERE EXISTS (SELECT 1 FROM decidable) AND m.deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(m.card->'grants') entry
       WHERE entry->>'grantId' IN (SELECT grant_id FROM decidable)
     )`,
  // `decidePermission`: the person the agent asked, or a Workspace manager.
  // Deciding posts a second card; only the original one still says pending.
  `WITH ${VIEWER_ROOMS}
   ${APPROVAL_FROM('write-access')}
   JOIN permission_authority permission ON permission.room_id=room.id
     AND permission.status='pending'
   JOIN messages m ON m.room_id=room.id AND m.card_type='permission'
     AND m.card->>'permissionId'=permission.permission_id AND m.card->>'status'='pending'
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL
     AND (permission.principal_id=$2 OR ${VIEWER_MANAGES_WORKSPACE})`,
  // An open question addressed to the viewer: tagged, or asked of its
  // requester when it tags nobody (`addressedToPersonSql`'s reading).
  `WITH ${VIEWER_ROOMS}
   ${APPROVAL_FROM('choice', 'choice.closes_at')}
   JOIN room_choices choice ON choice.room_id=room.id AND choice.status='open'
     AND choice.mode='question' AND (choice.closes_at IS NULL OR choice.closes_at>now())
   JOIN messages m ON m.id=choice.message_id AND m.card_type='${CHOICE_CARD_TYPE}'
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL
     AND CASE jsonb_array_length(COALESCE(m.card->'mentionIds','[]'::jsonb))
       WHEN 0 THEN m.card->'requester'->>'pubkey'=$2
       ELSE COALESCE(m.card->'mentionIds','[]'::jsonb) ? $2
     END`,
  // `acceptConnectorOffer`: the addressee, or a Workspace manager except for
  // a wallet, which only its addressee may accept.
  `WITH ${VIEWER_ROOMS}
   ${APPROVAL_FROM('connector')}
   JOIN connector_offers offer ON offer.room_id=room.id AND offer.status='pending'
   JOIN messages m ON m.id=offer.message_id
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL
     AND (offer.addressee_id=$2
       OR (offer.connector_type<>'wallet' AND ${VIEWER_MANAGES_WORKSPACE}))`,
  // `RoomWebhooks.decide`: a human Room or Workspace owner/admin.
  `WITH ${VIEWER_ROOMS}
   ${APPROVAL_FROM('webhook', 'webhook.expires_at')}
   JOIN room_webhook_requests webhook ON webhook.room_id=room.id
     AND webhook.status='pending' AND webhook.expires_at>now()
   JOIN messages m ON m.id=webhook.message_id
   JOIN identities viewer ON viewer.id=$2 AND viewer.kind='human'
   JOIN memberships viewer_member ON viewer_member.room_id=room.id
     AND viewer_member.identity_id=$2 AND viewer_member.removed_at IS NULL
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL
     AND (viewer_member.role IN ('owner','admin') OR ${VIEWER_MANAGES_WORKSPACE})`,
  // A sign-in only its owner can finish, while it still waits on them.
  `WITH ${VIEWER_ROOMS}
   ${APPROVAL_FROM(
     'sign-in',
     `CASE WHEN m.card->>'expiresAt' ~ '^[0-9]+$'
       THEN to_timestamp((m.card->>'expiresAt')::bigint/1000.0) END`,
     `(SELECT signing_in.name FROM identities signing_in WHERE signing_in.id=m.card->>'agentId')`,
   )}
   JOIN messages m ON m.room_id=room.id
     AND m.card_type IN ('agent-sign-in','app-sign-in')
     AND m.created_at>now()-interval '${NEEDS_YOU_LOOKBACK_DAYS} days'
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL AND m.card->>'ownerId'=$2
     AND CASE m.card_type
       WHEN 'agent-sign-in' THEN m.card->>'status' IN ('starting','pending')
         AND (m.card->>'expiresAt' IS NULL
           OR to_timestamp((m.card->>'expiresAt')::bigint/1000.0)>now())
       ELSE m.card->>'status'='pending'
     END`,
  // A Trusty Squire approval in the owner's connector DM. Squire decides it;
  // the decision (or Squire's expiry) lands in the Room the paused turn ran in.
  `WITH ${VIEWER_ROOMS}
   ${APPROVAL_FROM('squire')}
   JOIN messages m ON m.room_id=room.id AND m.card_type='squire-approval'
     AND m.created_at>now()-interval '${NEEDS_YOU_LOOKBACK_DAYS} days'
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL AND m.card->>'approvalId' IS NOT NULL
     AND m.card->>'sourceRoomId' ~ '^[0-9a-f-]{36}$'
     AND NOT EXISTS (
       SELECT 1 FROM messages decision
       WHERE decision.room_id=(m.card->>'sourceRoomId')::uuid
         AND decision.card_type='squire-approval-decision'
         AND decision.card->>'approvalId'=m.card->>'approvalId'
     )`,
];

/**
 * Whether `identityExpr` may decide the grant row `grant`: the agent's owner
 * for a personal resource, a Workspace owner/admin for a repository (the
 * `requireGrantAuthority` rule).
 */
export function grantDecidedBySql(grant: string, identityExpr: string): string {
  return `CASE WHEN ${grant}.kind='repository' THEN EXISTS (
      SELECT 1 FROM memberships manager
      WHERE manager.workspace_id=${grant}.workspace_id AND manager.room_id IS NULL
        AND manager.identity_id=${identityExpr} AND manager.removed_at IS NULL
        AND manager.role IN ('owner','admin'))
    ELSE EXISTS (
      SELECT 1 FROM agents grant_agent
      WHERE grant_agent.agent_id=${grant}.agent_id AND grant_agent.owner_id=${identityExpr})
    END`;
}

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
  const [tagged, ...approvals] = await Promise.all([
    database.query<Row>(
      `WITH ${VIEWER_ROOMS}
       SELECT ${ROW_COLUMNS},NULL::text approval_kind,NULL::timestamptz approval_expires_at,
         NULL::text[] pending_grant_ids,NULL::text actor_name
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
    ...APPROVAL_QUERIES.map((sql) => database.query<Row>(sql, [workspaceId, viewerId])),
  ]);
  const built = [
    ...tagged.rows.filter((row) => isNeedsYouAsk(row.text)),
    ...approvals.flatMap((result) => result.rows),
  ].flatMap((row) => {
    const approval = row.approval_kind ? approvalView(row, viewerId) : undefined;
    if (row.approval_kind && !approval) return [];
    const expiresAt = row.approval_kind
      ? row.approval_expires_at
        ? Math.floor(row.approval_expires_at.getTime() / 1000)
        : undefined
      : row.first_seen_at
        ? needsYouExpiresAt(row.first_seen_at)
        : undefined;
    return [{ row, approval, expiresAt }];
  });
  // Approvals before questions; within each, the soonest to expire, then the oldest.
  built.sort(
    (left, right) =>
      Number(!left.approval) - Number(!right.approval) ||
      (left.expiresAt ?? Infinity) - (right.expiresAt ?? Infinity) ||
      left.row.created_at.getTime() - right.row.created_at.getTime() ||
      (left.row.message_id < right.row.message_id ? -1 : 1),
  );
  const items = built.map(({ row, approval, expiresAt }): NeedsYouItemView => ({
    messageId: row.message_id,
    workspaceId,
    roomId: row.room_id,
    roomName: row.room_name,
    roomKind: row.room_kind,
    ...(row.parent_room_name ? { parentRoomName: row.parent_room_name } : {}),
    text: approval
      ? keepEnd(`${approval.actor} ${approval.ask} ${approval.subject}`)
      : needsYouRowText(row.text, viewer.handle),
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
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
    ...(approval ? { approval } : {}),
  }));
  return {
    items,
    // An approval has no clock: it stays until it is decided, expires or closes.
    unseen: built
      .filter(({ row }) => !row.approval_kind && !row.first_seen_at)
      .map(({ row }) => row.message_id),
  };
}

export function needsYouExpiresAt(firstSeenAt: Date): number {
  return Math.floor(firstSeenAt.getTime() / 1000) + NEEDS_YOU_EXPIRY_HOURS * 60 * 60;
}

const SQUIRE_ASKS: Record<NonNullable<ApprovalCard['linkKind']>, string> = {
  approval: 'asks you to approve',
  passkey: 'needs your passkey for',
  vouch: 'asks you to vouch for',
};

/**
 * One approval card as the tray's text row, or nothing when the card lacks
 * what the row needs. The verb carries the kind (`asks to run`,
 * `asks for write access to`), so the row needs no type label.
 */
function approvalView(
  row: Pick<Row, 'approval_kind' | 'card' | 'pending_grant_ids' | 'actor_name' | 'author_name'>,
  viewerId: string,
): NeedsYouApprovalView | undefined {
  const card = row.card ?? {};
  const text = (value: string | null | undefined) =>
    value?.replace(/\s+/g, ' ').trim() || undefined;
  const actor =
    text(card.agent?.name) ??
    text(card.agentName) ??
    text(row.actor_name) ??
    text(row.author_name) ??
    'An agent';
  // The person who asked the agent, named only when that is someone else.
  const forName =
    card.requester?.pubkey && card.requester.pubkey !== viewerId
      ? text(card.requester.name)
      : undefined;
  const view = (
    kind: NeedsYouApprovalKind,
    ask: string,
    subject: string | undefined,
    literal: boolean,
    detail?: string,
    requestedFor?: string,
  ): NeedsYouApprovalView | undefined =>
    subject
      ? {
          kind,
          actor,
          ask,
          subject,
          literal,
          ...(detail ? { detail } : {}),
          ...(requestedFor ? { forName: requestedFor } : {}),
        }
      : undefined;
  switch (row.approval_kind) {
    case 'grant': {
      const pending = (card.grants ?? []).filter(
        (entry) => entry.grantId && (row.pending_grant_ids ?? []).includes(entry.grantId),
      );
      const first = pending[0];
      if (!first?.kind || !first.target) return undefined;
      const more = pending.length > 1 ? ` (and ${pending.length - 1} more)` : '';
      return view(
        'grant',
        `asks to ${AGENT_GRANT_VERBS[first.kind] ?? 'use'}`,
        first.target,
        true,
        text(`${first.reason ?? ''}${more}`),
        forName,
      );
    }
    case 'write-access':
      return card.purpose === 'squire-spending'
        ? view('write-access', 'asks to spend with', text(card.tool), false, undefined, forName)
        : view(
            'write-access',
            'asks for write access to',
            text(card.repository),
            true,
            undefined,
            forName,
          );
    case 'choice':
      return view(
        'choice',
        'asks you to choose',
        text(card.prompt),
        false,
        text(
          (card.options ?? [])
            .map((option) => text(option.label))
            .filter(Boolean)
            .join(' · '),
        ),
      );
    case 'connector':
      return view(
        'connector',
        'asks to connect',
        text(card.connectorName),
        false,
        text(card.reason),
      );
    case 'webhook':
      return view('webhook', 'asks for a webhook from', text(card.source), true, text(card.reason));
    case 'sign-in':
      return view(
        'sign-in',
        'needs you to sign in to',
        card.harness ? AGENT_SIGN_IN_SERVICE_LABELS[card.harness] : text(card.name),
        false,
      );
    case 'squire':
      return view(
        'squire',
        SQUIRE_ASKS[card.linkKind ?? 'approval'] ?? SQUIRE_ASKS.approval,
        text(card.title),
        false,
        text(card.detail),
      );
    default:
      return undefined;
  }
}
