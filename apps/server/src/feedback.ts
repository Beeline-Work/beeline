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

/** Reads a pull request in the feedback repository (the Beeline GitHub App). */
export interface FeedbackPullRequests {
  /** True only when the pull request exists and has merged. */
  merged(repository: string, number: number): Promise<boolean>;
}

/** The feedback loop's server wiring: config plus the GitHub read it needs. */
export type FeedbackLoop = {
  readonly config: FeedbackConfig;
  readonly pullRequests?: FeedbackPullRequests;
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

/** The helper release and the phone's reported release share this shape. */
const RELEASE_VERSION = /^v\d+\.\d+\.\d+$/;
const HARNESS_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const APP_PLATFORMS = new Set(['ios', 'android', 'web', 'macos', 'windows', 'linux']);

type ReportVersions = {
  helperVersion: string | null;
  appVersion: string | null;
  appPlatform: string | null;
  harness: string | null;
  harnessVersion: string | null;
};

const UNKNOWN_VERSIONS: ReportVersions = {
  helperVersion: null,
  appVersion: null,
  appPlatform: null,
  harness: null,
  harnessVersion: null,
};

function releaseVersionOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && RELEASE_VERSION.test(trimmed) ? trimmed : null;
}

function harnessOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && HARNESS_NAME.test(trimmed) ? trimmed : null;
}

function platformOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && APP_PLATFORMS.has(trimmed) ? trimmed : null;
}

/**
 * Helper version from the connection's presence announcement, and the harness
 * kind the helper already posted. The harness process version never reaches
 * the server, so it stays null. App fields stay null: this is not a phone.
 */
async function agentReportVersions(database: SqlDatabase, agentId: string): Promise<ReportVersions> {
  const row = (
    await database.query<{ helper_version: string | null; harness: string | null }>(
      `SELECT presence.body->>'releaseVersion' AS helper_version, agent.harness
       FROM agents agent
       LEFT JOIN LATERAL (
         SELECT body FROM live_outputs
         WHERE agent_id=agent.agent_id AND kind='presence'
         ORDER BY updated_at DESC
         LIMIT 1
       ) presence ON true
       WHERE agent.agent_id=$1`,
      [agentId],
    )
  ).rows[0];
  return {
    ...UNKNOWN_VERSIONS,
    helperVersion: releaseVersionOrNull(row?.helper_version),
    harness: harnessOrNull(row?.harness),
  };
}

/**
 * App release and platform from the builds this person already reported with
 * `reportRunningUpdate`. A field is stored only when every receipt agrees.
 * Disagreeing devices, or no receipt, stay null. The sign-in funnel's package
 * version is a different number and is not used here.
 */
async function humanReportVersions(database: SqlDatabase, reporterId: string): Promise<ReportVersions> {
  const row = (
    await database.query<{ app_platform: string | null; app_version: string | null }>(
      `SELECT
         CASE WHEN count(*)>0 AND count(DISTINCT platform)=1 AND bool_and(platform IS NOT NULL)
           THEN min(platform) END AS app_platform,
         CASE WHEN count(*)>0 AND bool_and(version IS NOT NULL) AND count(DISTINCT version)=1
           THEN min(version) END AS app_version
       FROM (
         SELECT CASE WHEN receipt->>'platform' IN ('ios','android','web','macos','windows','linux')
                     THEN receipt->>'platform' END AS platform,
                CASE WHEN receipt->>'releaseVersion' ~ '^v[0-9]+\\.[0-9]+\\.[0-9]+$'
                     THEN receipt->>'releaseVersion' END AS version
         FROM device_update_receipts
         WHERE identity_id=$1
       ) reported`,
      [reporterId],
    )
  ).rows[0];
  return {
    ...UNKNOWN_VERSIONS,
    appVersion: releaseVersionOrNull(row?.app_version),
    appPlatform: platformOrNull(row?.app_platform),
  };
}

/** The trigger, then up to twenty earlier live messages from its Room, newest first. */
async function evidenceMessageIds(
  database: SqlDatabase,
  roomId: string,
  triggerMessageId: string | null,
): Promise<string[]> {
  if (!triggerMessageId) return [];
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
 * `report_feedback`, from inside the agent's authorized turn. The same
 * category, tool and normalized summary match any open agent item. Reports
 * beyond the daily safety ceiling share one bounded overflow item.
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
  const versions = await agentReportVersions(database, agentId);
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`feedback:${agentId}`]);
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `feedback-match:${JSON.stringify([input.category, summaryKey, toolName ?? null])}`,
  ]);
  const existing = (
    await database.query<{ id: string }>(
      `SELECT id FROM feedback_items
       WHERE source_kind='agent' AND category=$1 AND summary_key=$2
         AND tool_name IS NOT DISTINCT FROM $3::text
         AND status IN ('new','filed','attached')
       ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
      [input.category, summaryKey, toolName ?? null],
    )
  ).rows[0];
  if (existing) {
    // Original context stays on the item; later occurrences retain their own evidence.
    await database.query(
      `UPDATE feedback_items SET occurrence_count=occurrence_count+1,
         last_occurrence_at=now(), occurrences=occurrences || jsonb_build_array($3::jsonb || jsonb_build_object('createdAt',now()))
       WHERE id=$1
         AND NOT (reporter_identity_id=$2 AND created_at>now()-interval '1 hour')
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(occurrences) occurrence
           WHERE occurrence->>'agentId'=$2
             AND (occurrence->>'createdAt')::timestamptz>now()-interval '1 hour'
         )`,
      [
        existing.id,
        agentId,
        JSON.stringify({
          agentId,
          roomId: command.room_id,
          triggerMessageId: command.source_message_id,
          requestId: command.turn_request_id,
          messageIds: await evidenceMessageIds(
            database,
            command.room_id,
            command.source_message_id,
          ),
          promptSectionIds,
          summary,
          detail: detail ?? null,
          errorExcerpt: errorExcerpt ?? null,
          helperVersion: versions.helperVersion,
          harness: versions.harness,
          harnessVersion: versions.harnessVersion,
        }),
      ],
    );
    return { itemId: existing.id, duplicate: true };
  }
  const today = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM feedback_items
       WHERE source_kind='agent' AND reporter_identity_id=$1
         AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [agentId],
    )
  ).rows[0]!.count;
  const overflow = today >= FEEDBACK_AGENT_DAILY_CAP;
  // A reserved key (not producible by summary normalization) keeps overflow
  // separate from ordinary duplicate matching, including across agents.
  const overflowKey = overflow
    ? `overflow:${agentId}:${(await database.query<{ utc_day: string }>(
        "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day",
      )).rows[0]!.utc_day}`
    : undefined;
  const owner = (
    await database.query<{ owner_id: string }>(`SELECT owner_id FROM agents WHERE agent_id=$1`, [
      agentId,
    ])
  ).rows[0]?.owner_id;
  const id = overflowKey ? `fb_${overflowKey}` : feedbackItemId();
  const stored = await database.query<{ occurrence_count: number }>(
    `INSERT INTO feedback_items(
       id,source_kind,reporter_identity_id,reporter_owner_id,workspace_id,room_id,
       trigger_message_id,message_ids,request_id,category,summary,summary_key,detail,
       tool_name,error_excerpt,prompt_section_ids,
       helper_version,app_version,app_platform,harness,harness_version
     ) VALUES($1,'agent',$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14,$15::text[],
       $16,$17,$18,$19,$20)
     ${overflow ? `ON CONFLICT(id) DO UPDATE SET
       occurrence_count=feedback_items.occurrence_count+1, last_occurrence_at=now(),
       summary=EXCLUDED.summary, detail=EXCLUDED.detail, category=EXCLUDED.category,
       tool_name=EXCLUDED.tool_name, error_excerpt=EXCLUDED.error_excerpt,
       workspace_id=EXCLUDED.workspace_id, room_id=EXCLUDED.room_id,
       trigger_message_id=EXCLUDED.trigger_message_id, message_ids=EXCLUDED.message_ids,
       request_id=EXCLUDED.request_id, prompt_section_ids=EXCLUDED.prompt_section_ids,
       helper_version=EXCLUDED.helper_version, app_version=EXCLUDED.app_version,
       app_platform=EXCLUDED.app_platform, harness=EXCLUDED.harness,
       harness_version=EXCLUDED.harness_version,
       status='new', issue_repository=NULL, issue_number=NULL, triage_reason=NULL,
       triaged_at=NULL, resolved_notified_at=NULL` : ''}
     RETURNING occurrence_count`,
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
      overflowKey ?? summaryKey,
      detail ?? null,
      toolName ?? null,
      errorExcerpt ?? null,
      promptSectionIds,
      versions.helperVersion,
      versions.appVersion,
      versions.appPlatform,
      versions.harness,
      versions.harnessVersion,
    ],
  );
  return { itemId: id, duplicate: stored.rows[0]!.occurrence_count > 1 };
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
  const versions = await humanReportVersions(database, input.reporterId);
  const inserted = await database.query(
    `INSERT INTO feedback_items(
       id,source_kind,reporter_identity_id,workspace_id,room_id,trigger_message_id,
       message_ids,category,summary,summary_key,detail,
       helper_version,app_version,app_platform,harness,harness_version
     ) VALUES($1,'human',$2,$3,$4,$5,$6::text[],'human_report',$7,$8,$9,$10,$11,$12,$13,$14)
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
      versions.helperVersion,
      versions.appVersion,
      versions.appPlatform,
      versions.harness,
      versions.harnessVersion,
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
     JOIN effective_memberships membership ON membership.room_id=message.room_id
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

/** Resolve merged feedback silently; send Fixed DMs only on an explicit sender-rooted notify request. */
export async function notifyFeedbackFixed(
  database: SqlDatabase,
  { config, pullRequests }: FeedbackLoop,
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
  const notify = input.notify === true;
  if (notify) {
    const root = (await database.query<{ author_id: string }>(
      `SELECT message.author_id FROM messages message
       JOIN identities author ON author.id=message.author_id AND author.kind='human'
         AND NOT author.hidden_from_roster
       WHERE message.id=$1`, [command!.root_source_message_id],
    )).rows[0];
    if (!root || !config.systemSenders.includes(root.author_id))
      throw new Error('System DM access denied: Fixed notices need an explicit order from a configured System sender');
  }
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
  const number = Number(pull[2]);
  const url = `https://github.com/${config.repository}/pull/${number}`;
  if (!pullRequests)
    throw new Error('Fixed DMs are unavailable: the Beeline GitHub App is not configured');
  // Only a merged fix closes the loop; the agent's word that it merged is not enough.
  if (!(await pullRequests.merged(config.repository, number)))
    throw new Error(`${url} has not merged; nothing was resolved or sent`);
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
      `UPDATE feedback_items SET status='resolved',
         triaged_at=COALESCE(triaged_at,now())
       WHERE id=ANY($1::text[]) AND status<>'resolved'
       RETURNING source_kind,reporter_identity_id,workspace_id`,
      [itemIds],
    );
    if (!notify) return { resolved: resolved.rowCount ?? 0, notified: 0 };
    // A later explicit notice order can notify items already resolved silently.
    const reporters = await db.query<{ reporter_identity_id: string; workspace_id: string }>(
      `SELECT reporter_identity_id,workspace_id FROM feedback_items
       WHERE id=ANY($1::text[]) AND status='resolved' AND source_kind='human'
         AND resolved_notified_at IS NULL`, [itemIds],
    );
    const people = new Map(reporters.rows.map(row => [row.reporter_identity_id, row.workspace_id]));
    let notified = 0;
    for (const [person, workspaceId] of people) {
      if (await sendFixedMessage(db, person, workspaceId, title, url)) {
        notified++;
        await db.query(`UPDATE feedback_items SET resolved_notified_at=now()
          WHERE id=ANY($1::text[]) AND reporter_identity_id=$2 AND status='resolved'`, [itemIds, person]);
      }
    }
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
