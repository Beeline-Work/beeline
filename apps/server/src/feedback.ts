import { createHash, randomBytes } from 'node:crypto';
import {
  FEEDBACK_AGENT_CATEGORIES,
  FEEDBACK_AGENT_DAILY_CAP,
  FEEDBACK_CATEGORIES,
  FEEDBACK_DEFAULT_REPOSITORY,
  FEEDBACK_DETAIL_MAX_BYTES,
  FEEDBACK_ERROR_EXCERPT_MAX_BYTES,
  FEEDBACK_EVIDENCE_RUN_LENGTH,
  FEEDBACK_ISSUE_BODY_MAX_LENGTH,
  FEEDBACK_ISSUE_LABEL,
  FEEDBACK_ISSUE_TITLE_MAX_LENGTH,
  FEEDBACK_PRECEDING_MESSAGES,
  FEEDBACK_PROMPT_SECTION_IDS_MAX,
  FEEDBACK_SUMMARY_MAX_BYTES,
  FEEDBACK_TOOL_NAME_MAX_LENGTH,
  FEEDBACK_TRIAGE_REASON_MAX_LENGTH,
  type FeedbackCategory,
  type FeedbackEvidenceMessage,
  type FeedbackIssueSummary,
  type FeedbackItemDetail,
  type FeedbackItemSummary,
  type FeedbackStatus,
  type ReportFeedbackInput,
  type ReportFeedbackResult,
} from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { PROHIBITED_SECRET_PATTERNS } from './institutional-memory-shadow.js';
import { hasSystemReportMention } from './message-mentions.js';
import { ensureSystemDirectMessageRoom } from './system-line.js';

/**
 * The Beeline feedback loop's one store. Two intake paths write it: an
 * agent's in-turn `report_feedback` call, and a person's `@system` tag or
 * Report issue action. A triage agent in a corner with Feedback triage on,
 * run on an ordinary schedule in that corner, files new items as redacted
 * issues in the public repository, attaches them to an existing issue, or
 * dismisses them. The repository's
 * issue webhook then resolves them and tells each reporter it was fixed.
 * Items keep message ids only; evidence text is read live.
 */

export type FeedbackConfig = {
  readonly repository: string;
};

export function feedbackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeedbackConfig {
  return { repository: env.BEELINE_FEEDBACK_REPOSITORY?.trim() || FEEDBACK_DEFAULT_REPOSITORY };
}

/** The Issues calls the filing tools make, bound to one repository. */
export interface FeedbackIssueHost {
  createIssue(
    repository: string,
    issue: { title: string; body: string; labels: readonly string[] },
  ): Promise<{ number: number; url: string }>;
  readIssue(
    repository: string,
    number: number,
  ): Promise<FeedbackIssueSummary & { state: string; pullRequest: boolean }>;
  listOpenIssues(repository: string, label: string): Promise<FeedbackIssueSummary[]>;
  createComment(repository: string, number: number, body: string): Promise<{ id: number }>;
  /** False when the comment is gone, so the caller writes a new one. */
  updateComment(repository: string, commentId: number, body: string): Promise<boolean>;
}

/** A write refused by server-side redaction, naming the rule that failed. */
export class FeedbackRedactionError extends Error {
  constructor(
    readonly rule:
      | 'title-length'
      | 'body-length'
      | 'evidence-quote'
      | 'email'
      | 'secret'
      | 'person-name'
      | 'room-name',
    detail: string,
  ) {
    super(`feedback issue rejected by redaction rule ${rule}: ${detail}`);
  }
}

// Secret-shaped values: the institutional memory patterns plus a bare JWT.
const FEEDBACK_SECRET_PATTERNS: readonly RegExp[] = [
  ...PROHIBITED_SECRET_PATTERNS,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;

export function containsSecret(text: string): boolean {
  return FEEDBACK_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function optionalText(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (bytes(trimmed) > maxBytes) throw new Error(`${field} is longer than ${maxBytes} bytes`);
  return trimmed;
}

/** Case, punctuation and spacing never make two reports different. */
export function feedbackSummaryKey(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function feedbackItemId(): string {
  return `fb_${randomBytes(12).toString('hex')}`;
}

/** The trigger, then up to twenty earlier live messages from its Room, newest first. */
async function evidenceMessageIds(
  database: SqlDatabase,
  roomId: string,
  triggerMessageId: string,
): Promise<string[]> {
  const rows = await database.query<{ id: string }>(
    `SELECT earlier.id FROM messages trigger
     JOIN messages earlier ON earlier.room_id=trigger.room_id
       AND (earlier.created_at,earlier.id)<(trigger.created_at,trigger.id)
       AND earlier.deleted_at IS NULL AND earlier.presentation<>'activity'
     WHERE trigger.id=$1 AND trigger.room_id=$2
     ORDER BY earlier.created_at DESC,earlier.id DESC LIMIT ${FEEDBACK_PRECEDING_MESSAGES}`,
    [triggerMessageId, roomId],
  );
  return [triggerMessageId, ...rows.rows.map((row) => row.id)];
}

async function roomWorkspace(database: SqlDatabase, roomId: string): Promise<string> {
  const row = (
    await database.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
      roomId,
    ])
  ).rows[0];
  if (!row) throw new Error('room not found');
  return row.workspace_id;
}

/**
 * `report_feedback`, from inside the agent's authorized turn. Same reporter,
 * category and normalized summary within a day answer the existing id; ten
 * new items per agent per UTC day is the cap.
 */
export async function reportAgentFeedback(
  database: SqlDatabase,
  command: CommandRow,
  agentId: string,
  input: ReportFeedbackInput,
): Promise<ReportFeedbackResult> {
  if (!(FEEDBACK_AGENT_CATEGORIES as readonly string[]).includes(input.category))
    throw new Error(`category must be one of ${FEEDBACK_AGENT_CATEGORIES.join(', ')}`);
  const summary = optionalText(input.summary, 'summary', FEEDBACK_SUMMARY_MAX_BYTES);
  if (!summary) throw new Error('summary is required');
  const detail = optionalText(input.detail, 'detail', FEEDBACK_DETAIL_MAX_BYTES);
  const errorExcerpt = optionalText(
    input.errorExcerpt,
    'error_excerpt',
    FEEDBACK_ERROR_EXCERPT_MAX_BYTES,
  );
  const toolName = optionalText(input.toolName, 'tool_name', FEEDBACK_TOOL_NAME_MAX_LENGTH);
  const promptSectionIds = Array.isArray(input.promptSectionIds)
    ? [...new Set(input.promptSectionIds.filter((id) => typeof id === 'string' && id.length <= 120))]
        .slice(0, FEEDBACK_PROMPT_SECTION_IDS_MAX)
    : [];
  if (containsSecret([summary, detail, errorExcerpt, toolName].filter(Boolean).join('\n')))
    throw new Error('feedback contains a secret-shaped value; describe the problem without it');
  const summaryKey = feedbackSummaryKey(summary) || summary.toLowerCase();
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`feedback:${agentId}`]);
  const existing = (
    await database.query<{ id: string }>(
      `SELECT id FROM feedback_items
       WHERE source_kind='agent' AND reporter_identity_id=$1 AND category=$2 AND summary_key=$3
         AND created_at>now()-interval '24 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [agentId, input.category, summaryKey],
    )
  ).rows[0];
  if (existing) return { itemId: existing.id, duplicate: true };
  const today = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM feedback_items
       WHERE source_kind='agent' AND reporter_identity_id=$1
         AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [agentId],
    )
  ).rows[0]!.count;
  if (today >= FEEDBACK_AGENT_DAILY_CAP)
    throw new Error(
      `feedback cap reached: ${FEEDBACK_AGENT_DAILY_CAP} reports per agent per UTC day`,
    );
  const owner = (
    await database.query<{ owner_id: string }>(`SELECT owner_id FROM agents WHERE agent_id=$1`, [
      agentId,
    ])
  ).rows[0]?.owner_id;
  const id = feedbackItemId();
  await database.query(
    `INSERT INTO feedback_items(
       id,source_kind,reporter_identity_id,reporter_owner_id,workspace_id,room_id,
       trigger_message_id,message_ids,request_id,category,summary,summary_key,detail,
       tool_name,error_excerpt,prompt_section_ids
     ) VALUES($1,'agent',$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14,$15::text[])`,
    [
      id,
      agentId,
      owner ?? null,
      await roomWorkspace(database, command.room_id),
      command.room_id,
      command.source_message_id,
      await evidenceMessageIds(database, command.room_id, command.source_message_id),
      command.turn_request_id,
      input.category,
      summary,
      summaryKey,
      detail ?? null,
      toolName ?? null,
      errorExcerpt ?? null,
      promptSectionIds,
    ],
  );
  return { itemId: id, duplicate: false };
}

const TAG_SUMMARY = 'Reported with @system';
const ACTION_SUMMARY = 'Reported with Report issue';

async function insertHumanReport(
  database: SqlDatabase,
  input: {
    roomId: string;
    messageId: string;
    reporterId: string;
    summary: string;
    note?: string;
  },
): Promise<ReportFeedbackResult> {
  const id = feedbackItemId();
  const inserted = await database.query(
    `INSERT INTO feedback_items(
       id,source_kind,reporter_identity_id,workspace_id,room_id,trigger_message_id,
       message_ids,category,summary,summary_key,detail
     ) VALUES($1,'human',$2,$3,$4,$5,$6::text[],'human_report',$7,$8,$9)
     ON CONFLICT(trigger_message_id) WHERE source_kind='human' DO NOTHING`,
    [
      id,
      input.reporterId,
      await roomWorkspace(database, input.roomId),
      input.roomId,
      input.messageId,
      await evidenceMessageIds(database, input.roomId, input.messageId),
      input.summary,
      feedbackSummaryKey(input.summary),
      input.note ?? null,
    ],
  );
  if (!inserted.rowCount) {
    const existing = (
      await database.query<{ id: string }>(
        `SELECT id FROM feedback_items WHERE trigger_message_id=$1 AND source_kind='human'`,
        [input.messageId],
      )
    ).rows[0]!;
    return { itemId: existing.id, duplicate: true };
  }
  // Republish the message row so every open transcript picks up its
  // Reported marker; the live trigger fires on any update of `messages`.
  await database.query(`UPDATE messages SET reactions=reactions WHERE id=$1`, [input.messageId]);
  return { itemId: id, duplicate: false };
}

/**
 * A person's message that tags `@system` outside code and quotes. System is
 * never a member, so the tag resolves, wakes and pushes nobody; it only
 * files this message. A secret-shaped message files nothing.
 */
export async function recordSystemReportMention(
  database: SqlDatabase,
  input: { roomId: string; messageId: string; authorId: string; text: string },
): Promise<ReportFeedbackResult | undefined> {
  if (!hasSystemReportMention(input.text) || containsSecret(input.text)) return undefined;
  const author = (
    await database.query<{ kind: string }>(`SELECT kind FROM identities WHERE id=$1`, [
      input.authorId,
    ])
  ).rows[0];
  if (author?.kind !== 'human' || input.authorId === SYSTEM_IDENTITY_ID) return undefined;
  return insertHumanReport(database, {
    roomId: input.roomId,
    messageId: input.messageId,
    reporterId: input.authorId,
    summary: TAG_SUMMARY,
  });
}

/** The Report issue message action: the same item, for any message the reporter can read. */
export async function reportMessageIssue(
  database: SqlDatabase,
  input: { roomId: string; messageId: string; note?: string },
  reporterId: string,
): Promise<ReportFeedbackResult> {
  if (!/^[0-9a-f]{64}$/.test(input.messageId)) throw new Error('messageId is invalid');
  const note = optionalText(input.note, 'note', FEEDBACK_DETAIL_MAX_BYTES);
  if (note && containsSecret(note))
    throw new Error('the note contains a secret-shaped value; remove it and report again');
  const visible = await database.query(
    `SELECT 1 FROM messages message
     JOIN memberships membership ON membership.room_id=message.room_id
       AND membership.identity_id=$3 AND membership.removed_at IS NULL
     JOIN identities reporter ON reporter.id=$3 AND reporter.kind='human'
     WHERE message.id=$1 AND message.room_id=$2 AND message.deleted_at IS NULL`,
    [input.messageId, input.roomId, reporterId],
  );
  if (!visible.rowCount) throw new Error('message is not available to report');
  return database.transaction((db) =>
    insertHumanReport(db, {
      roomId: input.roomId,
      messageId: input.messageId,
      reporterId,
      summary: ACTION_SUMMARY,
      ...(note ? { note } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Triage (turns in a Feedback triage corner only)
// ---------------------------------------------------------------------------

/**
 * The triage tools serve one caller: an agent in a live corner a Room admin
 * turned Feedback triage on for, during that agent's own turn in that corner.
 * The setting is read on every call, so turning it off stops the next call.
 */
export async function assertFeedbackTriageTurn(
  database: SqlDatabase,
  command: CommandRow | undefined,
  agentId: string,
): Promise<void> {
  const allowed =
    command?.agent_id === agentId &&
    (
      await database.query(
        `SELECT 1 FROM corner_facts fact
         JOIN rooms corner ON corner.id=fact.corner_id
           AND corner.parent_id IS NOT NULL AND corner.archived_at IS NULL
         JOIN memberships member ON member.room_id=corner.id
           AND member.identity_id=$2 AND member.removed_at IS NULL
         WHERE fact.corner_id=$1 AND fact.feedback_triage`,
        [command.room_id, agentId],
      )
    ).rowCount;
  if (!allowed)
    throw new Error(
      'feedback triage access denied: it runs only in your own turn in a corner with Feedback triage on',
    );
}

/**
 * A Room admin turns Feedback triage on or off by asking an agent in the
 * corner (`set_feedback_triage`). The change serves only that agent's own turn
 * in a live corner it is a member of, and only when the turn's root requester
 * is a human owner or admin of the corner's workspace.
 */
export async function setCornerFeedbackTriage(
  database: SqlDatabase,
  command: CommandRow | undefined,
  agentId: string,
  enabled: boolean,
): Promise<{ readonly cornerId: string; readonly enabled: boolean }> {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const updated =
    command?.agent_id === agentId
      ? await database.query(
          `UPDATE corner_facts fact SET feedback_triage=$3,updated_at=now()
           FROM rooms corner
           JOIN memberships member ON member.room_id=corner.id
             AND member.identity_id=$2 AND member.removed_at IS NULL
           JOIN messages root ON root.id=$4
           JOIN identities requester ON requester.id=root.author_id AND requester.kind='human'
           JOIN memberships manager ON manager.workspace_id=corner.workspace_id
             AND manager.room_id IS NULL AND manager.identity_id=requester.id
             AND manager.role IN ('owner','admin') AND manager.removed_at IS NULL
           WHERE fact.corner_id=$1 AND corner.id=fact.corner_id
             AND corner.parent_id IS NOT NULL AND corner.archived_at IS NULL`,
          [command.room_id, agentId, enabled, command.root_source_message_id],
        )
      : undefined;
  if (!updated?.rowCount)
    throw new Error(
      'feedback triage change access denied: only a Room admin can ask for it, in your own turn in a corner',
    );
  return { cornerId: command!.room_id, enabled };
}

type ItemRow = {
  id: string;
  source_kind: 'agent' | 'human';
  reporter_identity_id: string;
  reporter_owner_id: string | null;
  room_id: string | null;
  trigger_message_id: string | null;
  message_ids: string[];
  request_id: string | null;
  category: FeedbackCategory;
  summary: string;
  detail: string | null;
  tool_name: string | null;
  error_excerpt: string | null;
  prompt_section_ids: string[];
  status: FeedbackStatus;
  issue_number: number | null;
  triage_reason: string | null;
  created_at: Date;
  cluster_size: number;
};

// Agent reports cluster on category and normalized summary; a human report
// is its own cluster.
const CLUSTER_SQL = `count(*) OVER (PARTITION BY CASE WHEN item.source_kind='human'
  THEN item.id ELSE item.category||':'||item.summary_key END)::int`;

function summaryOf(row: ItemRow): FeedbackItemSummary {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    category: row.category,
    summary: row.summary,
    status: row.status,
    clusterSize: row.cluster_size,
    createdAt: Math.floor(row.created_at.getTime() / 1_000),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.issue_number ? { issueNumber: row.issue_number } : {}),
  };
}

/** New items: human reports first, then the biggest agent clusters. */
export async function listFeedback(
  database: SqlDatabase,
  limit = 50,
): Promise<{ items: FeedbackItemSummary[] }> {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await database.query<ItemRow>(
    `SELECT item.*,${CLUSTER_SQL} cluster_size FROM feedback_items item
     WHERE item.status='new'
     ORDER BY (item.source_kind='human') DESC,cluster_size DESC,item.created_at,item.id
     LIMIT ${bounded}`,
  );
  return { items: rows.rows.map(summaryOf) };
}

function uniqueIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))];
  if (!unique.length) throw new Error('item_ids is required');
  if (unique.length > 50) throw new Error('at most 50 item_ids per call');
  return unique;
}

async function loadItems(
  database: SqlDatabase,
  ids: readonly string[],
  lock = false,
): Promise<ItemRow[]> {
  const rows = await database.query<ItemRow>(
    `SELECT item.*,1 cluster_size FROM feedback_items item WHERE item.id=ANY($1::text[])
     ORDER BY item.created_at,item.id${lock ? ' FOR UPDATE' : ''}`,
    [ids],
  );
  const missing = ids.filter((id) => !rows.rows.some((row) => row.id === id));
  if (missing.length) throw new Error(`unknown feedback items: ${missing.join(', ')}`);
  return rows.rows;
}

async function evidenceFor(
  database: SqlDatabase,
  items: readonly ItemRow[],
): Promise<Map<string, FeedbackEvidenceMessage[]>> {
  const ids = [...new Set(items.flatMap((item) => item.message_ids))];
  const rows = await database.query<{
    id: string;
    room_id: string;
    text: string;
    created_at: Date;
    kind: string | null;
  }>(
    `SELECT message.id,message.room_id,message.text,message.created_at,author.kind
     FROM messages message LEFT JOIN identities author ON author.id=message.author_id
     WHERE message.id=ANY($1::text[]) AND message.deleted_at IS NULL`,
    [ids],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const evidence = new Map<string, FeedbackEvidenceMessage[]>();
  for (const item of items) {
    evidence.set(
      item.id,
      item.message_ids
        .map((id) => byId.get(id))
        .filter((row) => row !== undefined && row.room_id === item.room_id)
        .map((row) => ({
          id: row!.id,
          authorKind:
            row!.kind === 'human' || row!.kind === 'agent' ? row!.kind : ('unknown' as const),
          text: row!.text,
          createdAt: Math.floor(row!.created_at.getTime() / 1_000),
        })),
    );
  }
  return evidence;
}

/** Items with their evidence read live under server authority, whether or not the reporter stayed. */
export async function getFeedback(
  database: SqlDatabase,
  itemIds: readonly string[],
): Promise<{ items: FeedbackItemDetail[] }> {
  const items = await loadItems(database, uniqueIds(itemIds));
  const evidence = await evidenceFor(database, items);
  return {
    items: items.map((row) => ({
      ...summaryOf(row),
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.error_excerpt ? { errorExcerpt: row.error_excerpt } : {}),
      promptSectionIds: row.prompt_section_ids,
      ...(row.request_id ? { requestId: row.request_id } : {}),
      ...(row.trigger_message_id ? { triggerMessageId: row.trigger_message_id } : {}),
      ...(row.triage_reason ? { triageReason: row.triage_reason } : {}),
      evidence: evidence.get(row.id) ?? [],
    })),
  };
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])@?${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
}

/**
 * Every rule a public GitHub write must pass, checked in a fixed order so the
 * refusal names the first rule that failed. Evidence and names come from the
 * linked items only; nothing is rewritten, only accepted or refused.
 */
export function assertFeedbackRedaction(
  write: { title?: string; body: string },
  context: {
    evidence: readonly string[];
    personNames: readonly string[];
    roomNames: readonly string[];
  },
): void {
  const title = write.title ?? '';
  if (write.title !== undefined && title.length > FEEDBACK_ISSUE_TITLE_MAX_LENGTH)
    throw new FeedbackRedactionError(
      'title-length',
      `title is ${title.length} characters; the limit is ${FEEDBACK_ISSUE_TITLE_MAX_LENGTH}`,
    );
  if (write.body.length > FEEDBACK_ISSUE_BODY_MAX_LENGTH)
    throw new FeedbackRedactionError(
      'body-length',
      `body is ${write.body.length} characters; the limit is ${FEEDBACK_ISSUE_BODY_MAX_LENGTH}`,
    );
  const text = `${title}\n${write.body}`;
  const candidate = normalizeSpace(text);
  if (candidate.length >= FEEDBACK_EVIDENCE_RUN_LENGTH) {
    const windows = new Set<string>();
    for (let index = 0; index + FEEDBACK_EVIDENCE_RUN_LENGTH <= candidate.length; index++)
      windows.add(candidate.slice(index, index + FEEDBACK_EVIDENCE_RUN_LENGTH));
    for (const source of context.evidence) {
      const normalized = normalizeSpace(source);
      for (let index = 0; index + FEEDBACK_EVIDENCE_RUN_LENGTH <= normalized.length; index++)
        if (windows.has(normalized.slice(index, index + FEEDBACK_EVIDENCE_RUN_LENGTH)))
          throw new FeedbackRedactionError(
            'evidence-quote',
            `it repeats ${FEEDBACK_EVIDENCE_RUN_LENGTH}+ characters of linked evidence verbatim; describe it in your own words`,
          );
    }
  }
  if (EMAIL.test(text)) throw new FeedbackRedactionError('email', 'it contains an email address');
  if (containsSecret(text))
    throw new FeedbackRedactionError('secret', 'it contains a secret-shaped value');
  for (const name of context.personNames)
    if (name.length >= 3 && wordPattern(name).test(text))
      throw new FeedbackRedactionError('person-name', 'it names a person from the evidence');
  for (const name of context.roomNames)
    if (name.length >= 3 && wordPattern(name).test(text))
      throw new FeedbackRedactionError('room-name', 'it names a Room from the evidence');
}

async function redactionContext(
  database: SqlDatabase,
  items: readonly ItemRow[],
): Promise<{ evidence: string[]; personNames: string[]; roomNames: string[] }> {
  const evidence = await evidenceFor(database, items);
  const roomIds = [...new Set(items.map((item) => item.room_id).filter(Boolean))] as string[];
  const reporterIds = items
    .filter((item) => item.source_kind === 'human')
    .map((item) => item.reporter_identity_id);
  const people = await database.query<{ name: string; handle: string | null }>(
    `SELECT DISTINCT identity.name,identity.handle FROM identities identity
     WHERE identity.kind='human' AND NOT identity.hidden_from_roster AND (
       identity.id=ANY($2::text[]) OR EXISTS(
         SELECT 1 FROM memberships membership JOIN rooms room ON room.id=ANY($1::uuid[])
         WHERE membership.identity_id=identity.id
           AND (membership.room_id=room.id OR membership.room_id=room.parent_id)))`,
    [roomIds, reporterIds],
  );
  const rooms = await database.query<{ name: string }>(
    `SELECT DISTINCT surface.name FROM rooms room
     JOIN rooms surface ON surface.id=room.id OR surface.id=room.parent_id
     WHERE room.id=ANY($1::uuid[])`,
    [roomIds],
  );
  return {
    evidence: [
      ...[...evidence.values()].flat().map((message) => message.text),
      ...items.filter((item) => item.source_kind === 'human' && item.detail).map((item) => item.detail!),
    ],
    personNames: people.rows
      .flatMap((person) => [person.name, person.handle ?? ''])
      .map((name) => name.trim().replace(/^@/, ''))
      .filter(Boolean),
    roomNames: rooms.rows.map((room) => room.name.trim().replace(/^#/, '')).filter(Boolean),
  };
}

function reportCounts(items: readonly { source_kind: string }[]): string {
  const human = items.filter((item) => item.source_kind === 'human').length;
  const agent = items.length - human;
  return `${items.length} report${items.length === 1 ? '' : 's'} (${human} human, ${agent} agent)`;
}

function assertAllNew(items: readonly ItemRow[]): void {
  const settled = items.filter((item) => item.status !== 'new');
  if (settled.length)
    throw new Error(
      `feedback items are already triaged: ${settled.map((item) => `${item.id} (${item.status})`).join(', ')}`,
    );
}

function gitHubReason(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`GitHub refused the write; items stay new: ${message}`);
}

/**
 * Marks items triaged only if they are still new, so a sweep that raced
 * another never moves an item twice. GitHub is called before this and
 * outside any transaction: a refusal there leaves every item new.
 */
async function markTriaged(
  database: SqlDatabase,
  ids: readonly string[],
  status: 'filed' | 'attached',
  repository: string,
  issueNumber: number,
): Promise<string[]> {
  const updated = await database.query<{ id: string }>(
    `UPDATE feedback_items SET status=$2,issue_repository=$3,issue_number=$4,triaged_at=now()
     WHERE id=ANY($1::text[]) AND status='new' RETURNING id`,
    [ids, status, repository, issueNumber],
  );
  return ids.filter((id) => updated.rows.some((row) => row.id === id));
}

/** One new public issue for new items, with server labels and footer. */
export async function fileFeedbackIssue(
  database: SqlDatabase,
  config: FeedbackConfig,
  host: FeedbackIssueHost | undefined,
  input: { itemIds: readonly string[]; title: string; body: string; categoryLabel: string },
): Promise<{ issueNumber: number; url: string; itemIds: string[] }> {
  if (!host) throw new Error('feedback filing is unavailable: the Beeline GitHub App is not configured');
  if (!(FEEDBACK_CATEGORIES as readonly string[]).includes(input.categoryLabel))
    throw new Error(`category_label must be one of ${FEEDBACK_CATEGORIES.join(', ')}`);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!title || !body) throw new Error('title and body are required');
  const ids = uniqueIds(input.itemIds);
  const items = await loadItems(database, ids);
  assertAllNew(items);
  // The limit is GitHub's body as sent, so it counts the server's footer too.
  const footer = `\n\n---\nBeeline feedback: ${items[0]!.id} · ${reportCounts(items)}`;
  const issueBody = `${body}${footer}`;
  if (issueBody.length > FEEDBACK_ISSUE_BODY_MAX_LENGTH)
    throw new FeedbackRedactionError(
      'body-length',
      `body is ${issueBody.length} characters with the ${footer.length}-character server footer; ` +
        `the limit is ${FEEDBACK_ISSUE_BODY_MAX_LENGTH}, so write at most ${FEEDBACK_ISSUE_BODY_MAX_LENGTH - footer.length}`,
    );
  assertFeedbackRedaction({ title, body }, await redactionContext(database, items));
  let created: { number: number; url: string };
  try {
    created = await host.createIssue(config.repository, {
      title,
      body: issueBody,
      labels: [FEEDBACK_ISSUE_LABEL, input.categoryLabel],
    });
  } catch (error) {
    throw gitHubReason(error);
  }
  return {
    issueNumber: created.number,
    url: created.url,
    itemIds: await markTriaged(database, ids, 'filed', config.repository, created.number),
  };
}

/** Link new items to an open feedback issue and refresh its one report-count comment. */
export async function attachFeedbackToIssue(
  database: SqlDatabase,
  config: FeedbackConfig,
  host: FeedbackIssueHost | undefined,
  input: { itemIds: readonly string[]; issueNumber: number },
): Promise<{ issueNumber: number; url: string; itemIds: string[] }> {
  if (!host) throw new Error('feedback filing is unavailable: the Beeline GitHub App is not configured');
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)
    throw new Error('issue_number is invalid');
  const ids = uniqueIds(input.itemIds);
  const items = await loadItems(database, ids);
  assertAllNew(items);
  let issue: Awaited<ReturnType<FeedbackIssueHost['readIssue']>>;
  try {
    issue = await host.readIssue(config.repository, input.issueNumber);
  } catch (error) {
    throw gitHubReason(error);
  }
  if (issue.pullRequest || !issue.labels.includes(FEEDBACK_ISSUE_LABEL))
    throw new Error(`#${input.issueNumber} is not a ${FEEDBACK_ISSUE_LABEL} issue`);
  if (issue.state !== 'open') throw new Error(`#${input.issueNumber} is closed`);
  const linked = await database.query<{ source_kind: string }>(
    `SELECT source_kind FROM feedback_items WHERE issue_repository=$1 AND issue_number=$2`,
    [config.repository, input.issueNumber],
  );
  const comment = `Beeline feedback: ${reportCounts([...linked.rows, ...items])}`;
  const existing = (
    await database.query<{ comment_id: string }>(
      `SELECT comment_id FROM feedback_issue_comments WHERE repository=$1 AND issue_number=$2`,
      [config.repository, input.issueNumber],
    )
  ).rows[0];
  try {
    const updated =
      existing &&
      (await host.updateComment(config.repository, Number(existing.comment_id), comment));
    if (!updated) {
      const created = await host.createComment(config.repository, input.issueNumber, comment);
      await database.query(
        `INSERT INTO feedback_issue_comments(repository,issue_number,comment_id) VALUES($1,$2,$3)
         ON CONFLICT(repository,issue_number) DO UPDATE SET comment_id=EXCLUDED.comment_id,updated_at=now()`,
        [config.repository, input.issueNumber, created.id],
      );
    }
  } catch (error) {
    throw gitHubReason(error);
  }
  return {
    issueNumber: input.issueNumber,
    url: issue.url,
    itemIds: await markTriaged(database, ids, 'attached', config.repository, input.issueNumber),
  };
}

export async function dismissFeedback(
  database: SqlDatabase,
  input: { itemIds: readonly string[]; reason: string },
): Promise<{ itemIds: string[] }> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new Error('reason is required');
  if (reason.length > FEEDBACK_TRIAGE_REASON_MAX_LENGTH)
    throw new Error(`reason is longer than ${FEEDBACK_TRIAGE_REASON_MAX_LENGTH} characters`);
  const ids = uniqueIds(input.itemIds);
  return database.transaction(async (db) => {
    assertAllNew(await loadItems(db, ids, true));
    await db.query(
      `UPDATE feedback_items SET status='dismissed',triage_reason=$2,triaged_at=now()
       WHERE id=ANY($1::text[])`,
      [ids, reason],
    );
    return { itemIds: ids };
  });
}

// ---------------------------------------------------------------------------
// Close the loop
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The person who hears about a fix: a human reporter, or an agent's owner. */
async function notifyFixed(
  database: SqlDatabase,
  personId: string,
  preferredWorkspaceId: string,
  issue: { repository: string; number: number; title: string; url: string },
): Promise<boolean> {
  const workspace = (
    await database.query<{ workspace_id: string }>(
      `SELECT membership.workspace_id FROM memberships membership
       JOIN identities person ON person.id=membership.identity_id AND person.kind='human'
       WHERE membership.identity_id=$1 AND membership.room_id IS NULL
         AND membership.removed_at IS NULL
       ORDER BY (membership.workspace_id=$2::uuid) DESC,membership.joined_at,membership.workspace_id
       LIMIT 1`,
      [personId, preferredWorkspaceId],
    )
  ).rows[0];
  // A deleted account has no Workspace left to read a DM in.
  if (!workspace) return false;
  const roomId = await ensureSystemDirectMessageRoom(database, workspace.workspace_id, personId);
  const id = createHash('sha256')
    .update(`beeline-feedback-fixed:v1:${issue.repository.toLowerCase()}#${issue.number}:${personId}`)
    .digest('hex');
  const inserted = await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [id, roomId, SYSTEM_IDENTITY_ID, `Fixed: ${issue.title} (#${issue.number}) ${issue.url}`],
  );
  return Boolean(inserted.rowCount);
}

/**
 * `issues` deliveries for the configured repository, whatever any Room's
 * GitHub events setting says. Completed closes resolve and DM each reporter
 * once; not-planned closes close silently; a reopen returns items to filed.
 * Every step is conditional, so a redelivery changes and sends nothing.
 */
export async function processFeedbackIssueEvent(
  database: SqlDatabase,
  config: FeedbackConfig,
  payload: unknown,
): Promise<{ changed: number; notified: number }> {
  const body = record(payload);
  const repository = record(body?.repository)?.full_name;
  const issue = record(body?.issue);
  const action = body?.action;
  if (
    typeof repository !== 'string' ||
    repository.toLowerCase() !== config.repository.toLowerCase() ||
    !issue ||
    issue.pull_request !== undefined ||
    typeof issue.number !== 'number' ||
    (action !== 'closed' && action !== 'reopened')
  )
    return { changed: 0, notified: 0 };
  const number = issue.number;
  if (action === 'reopened') {
    const reopened = await database.query(
      `UPDATE feedback_items SET status='filed'
       WHERE lower(issue_repository)=lower($1) AND issue_number=$2 AND status IN ('resolved','closed')`,
      [repository, number],
    );
    return { changed: reopened.rowCount ?? 0, notified: 0 };
  }
  if (issue.state_reason !== 'completed') {
    const closed = await database.query(
      `UPDATE feedback_items SET status='closed'
       WHERE lower(issue_repository)=lower($1) AND issue_number=$2 AND status IN ('filed','attached')`,
      [repository, number],
    );
    return { changed: closed.rowCount ?? 0, notified: 0 };
  }
  return database.transaction(async (db) => {
    const resolved = await db.query<{
      source_kind: string;
      reporter_identity_id: string;
      reporter_owner_id: string | null;
      workspace_id: string;
    }>(
      `UPDATE feedback_items SET status='resolved',resolved_notified_at=now()
       WHERE lower(issue_repository)=lower($1) AND issue_number=$2 AND status IN ('filed','attached')
       RETURNING source_kind,reporter_identity_id,reporter_owner_id,workspace_id`,
      [repository, number],
    );
    const people = new Map<string, string>();
    for (const row of resolved.rows) {
      const person = row.source_kind === 'human' ? row.reporter_identity_id : row.reporter_owner_id;
      if (person && !people.has(person)) people.set(person, row.workspace_id);
    }
    const title = typeof issue.title === 'string' ? issue.title : `issue #${number}`;
    const url =
      typeof issue.html_url === 'string'
        ? issue.html_url
        : `https://github.com/${repository}/issues/${number}`;
    let notified = 0;
    for (const [person, workspaceId] of people)
      if (await notifyFixed(db, person, workspaceId, { repository, number, title, url }))
        notified++;
    return { changed: resolved.rowCount ?? 0, notified };
  });
}
