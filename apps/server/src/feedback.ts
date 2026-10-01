import { createHash, randomBytes } from 'node:crypto';
import {
  FEEDBACK_AGENT_CATEGORIES,
  FEEDBACK_AGENT_DAILY_CAP,
  FEEDBACK_DEFAULT_REPOSITORY,
  FEEDBACK_DETAIL_MAX_BYTES,
  FEEDBACK_ERROR_EXCERPT_MAX_BYTES,
  FEEDBACK_FIXED_ITEMS_MAX,
  FEEDBACK_FIXED_TITLE_MAX_LENGTH,
  FEEDBACK_PRECEDING_MESSAGES,
  FEEDBACK_PROMPT_SECTION_IDS_MAX,
  FEEDBACK_SUMMARY_MAX_BYTES,
  FEEDBACK_TOOL_NAME_MAX_LENGTH,
  type NotifyFeedbackFixedInput,
  type NotifyFeedbackFixedResult,
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
 * Report issue action. Triage is not server code: the saved `feedback-triage`
 * workflow (docs/workflows/) reads `feedback_items` through a read-only
 * database grant and dispatches fix corners after a human approves. When a
 * fix merges, the triage agent calls `notify_feedback_fixed` and System tells
 * each person who reported the problem themselves.
 * Items keep message ids, plus the text of a person's own `@system` report.
 */

export type FeedbackConfig = {
  /** The repository fix pull requests land in; a Fixed DM links only there. */
  readonly repository: string;
  /** Owners whose agents may have System send Fixed DMs (`BEELINE_SYSTEM_SENDERS`). */
  readonly systemSenders: readonly string[];
};

export function feedbackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeedbackConfig {
  return {
    repository: env.BEELINE_FEEDBACK_REPOSITORY?.trim() || FEEDBACK_DEFAULT_REPOSITORY,
    systemSenders: (env.BEELINE_SYSTEM_SENDERS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
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

/** The longest prefix of `text` that fits `maxBytes`, never splitting a character. */
function clipBytes(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  let clipped = '';
  let used = 0;
  for (const character of text) {
    used += bytes(character);
    if (used > maxBytes) break;
    clipped += character;
  }
  return clipped;
}

/**
 * A person's message that tags `@system` outside code and quotes. System is
 * never a member, so the tag resolves, wakes and pushes nobody; it only
 * files this message. The person wrote it to System, so its text is kept on
 * the item for the triage workflow, which reads `feedback_items` only. A
 * secret-shaped message files nothing.
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
    note: clipBytes(input.text.trim(), FEEDBACK_DETAIL_MAX_BYTES),
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
// Close the loop
// ---------------------------------------------------------------------------

/**
 * `notify_feedback_fixed`: the triage agent reports that a merged pull request
 * fixed these items. System, whose identity only the server holds, DMs each
 * person who reported one of them themselves, once per pull request; agent
 * reports resolve silently. Checked on every call: the agent's own turn, an
 * owner listed in `BEELINE_SYSTEM_SENDERS`, a pull request in the configured
 * repository, and a one-line title with no secret. The text is fixed.
 */
export async function notifyFeedbackFixed(
  database: SqlDatabase,
  config: FeedbackConfig,
  command: CommandRow | undefined,
  agentId: string,
  input: NotifyFeedbackFixedInput,
): Promise<NotifyFeedbackFixedResult> {
  const owner =
    command?.agent_id === agentId
      ? (
          await database.query<{ owner_id: string }>(
            `SELECT owner_id FROM agents WHERE agent_id=$1`,
            [agentId],
          )
        ).rows[0]?.owner_id
      : undefined;
  if (!owner || !config.systemSenders.includes(owner))
    throw new Error(
      'System DM access denied: only agents whose owner is a configured System sender can send Fixed DMs, in their own turn',
    );
  const itemIds = Array.isArray(input.itemIds)
    ? [...new Set(input.itemIds.filter((id): id is string => typeof id === 'string'))]
    : [];
  if (!itemIds.length || itemIds.length > FEEDBACK_FIXED_ITEMS_MAX)
    throw new Error(`item_ids must list 1 to ${FEEDBACK_FIXED_ITEMS_MAX} feedback items`);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > FEEDBACK_FIXED_TITLE_MAX_LENGTH || /[\r\n]/.test(title))
    throw new Error(`title must be one line of 1 to ${FEEDBACK_FIXED_TITLE_MAX_LENGTH} characters`);
  if (containsSecret(title)) throw new Error('title contains a secret-shaped value');
  const prUrl = typeof input.prUrl === 'string' ? input.prUrl.trim() : '';
  const pull = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/([1-9][0-9]*)$/.exec(prUrl);
  if (!pull || pull[1]!.toLowerCase() !== config.repository.toLowerCase())
    throw new Error(`pr_url must be a pull request in ${config.repository}`);
  const url = `https://github.com/${config.repository}/pull/${pull[2]}`;
  return database.transaction(async (db) => {
    const known = await db.query<{ id: string }>(
      `SELECT id FROM feedback_items WHERE id=ANY($1::text[])`,
      [itemIds],
    );
    if (known.rowCount !== itemIds.length) throw new Error('item_ids names an unknown feedback item');
    const resolved = await db.query<{
      source_kind: string;
      reporter_identity_id: string;
      workspace_id: string;
    }>(
      `UPDATE feedback_items SET status='resolved',resolved_notified_at=now(),
         triaged_at=COALESCE(triaged_at,now())
       WHERE id=ANY($1::text[]) AND status<>'resolved'
       RETURNING source_kind,reporter_identity_id,workspace_id`,
      [itemIds],
    );
    const people = new Map<string, string>();
    for (const row of resolved.rows)
      if (row.source_kind === 'human' && !people.has(row.reporter_identity_id))
        people.set(row.reporter_identity_id, row.workspace_id);
    let notified = 0;
    for (const [person, workspaceId] of people)
      if (await sendFixedMessage(db, person, workspaceId, title, url)) notified++;
    return { resolved: resolved.rowCount ?? 0, notified };
  });
}

/** One System DM per person and pull request; a repeat inserts nothing. */
async function sendFixedMessage(
  database: SqlDatabase,
  personId: string,
  preferredWorkspaceId: string,
  title: string,
  url: string,
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
    .update(`beeline-feedback-fixed:v2:${url.toLowerCase()}:${personId}`)
    .digest('hex');
  const inserted = await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [id, roomId, SYSTEM_IDENTITY_ID, `Fixed: ${title} ${url}`],
  );
  return Boolean(inserted.rowCount);
}
