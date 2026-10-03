import { createHash } from 'node:crypto';
import {
  CORNER_BRIEF_SPEC_MAX_LENGTH,
  type CornerBrief,
  type CornerBriefAttachment,
  type CornerBriefDraft,
  type CornerValidationStageName,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

/** Most files one brief revision may carry. */
const CORNER_BRIEF_ATTACHMENT_LIMIT = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CORNER_VALIDATION_STAGES: readonly CornerValidationStageName[] = [
  'intent',
  'base',
  'review',
  'tests',
  'docs',
  'lint_types',
  'publication',
  'ci',
  'final_authorization',
];

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
}

export function validateCornerBrief(draft: CornerBriefDraft): void {
  if (!draft || typeof draft !== 'object') throw new Error('corner brief is required');
  if (!boundedText(draft.spec, CORNER_BRIEF_SPEC_MAX_LENGTH))
    throw new Error(
      `corner brief spec must contain 1–${CORNER_BRIEF_SPEC_MAX_LENGTH} characters of Markdown`,
    );
  if (!draft.approval || !boundedText(draft.approval.sourceMessageId, 256))
    throw new Error('corner brief approval must name a human Room message');
  if (
    draft.change !== undefined &&
    (typeof draft.change !== 'string' || draft.change.length > 1_000)
  )
    throw new Error('corner brief change must be at most 1000 characters');
  const attachments = draft.attachments;
  if (!Array.isArray(attachments) && attachments !== undefined)
    throw new Error('corner brief attachments must be a list');
  if ((attachments?.length ?? 0) > CORNER_BRIEF_ATTACHMENT_LIMIT)
    throw new Error('corner brief has too many attachments');
  const ids = new Set<string>();
  for (const item of attachments ?? []) {
    const normalizedId = item?.objectId?.toLowerCase();
    if (
      !item ||
      typeof item.objectId !== 'string' ||
      !UUID.test(item.objectId) ||
      typeof item.purpose !== 'string' ||
      !item.purpose.trim() ||
      item.purpose.length > 500 ||
      typeof item.required !== 'boolean' ||
      ids.has(normalizedId)
    )
      throw new Error('invalid corner brief attachment');
    ids.add(normalizedId);
  }
}

export async function resolveCornerBriefAttachments(
  db: SqlDatabase,
  sourceRoomIds: readonly string[],
  draft: CornerBriefDraft,
  pending?: { roomId: string; agentId: string; requestId: string; generationId?: string },
): Promise<CornerBriefAttachment[]> {
  validateCornerBrief(draft);
  const resolved: CornerBriefAttachment[] = [];
  for (const item of draft.attachments ?? []) {
    const object = (
      await db.query<{
        title: string | null;
        mime: string;
        sha256: string;
        size: string;
      }>(
        `SELECT o.title,o.mime,o.sha256,o.size FROM objects o
       WHERE o.id=$1 AND o.state='ready'
         AND (o.expires_at>now() OR EXISTS (
           SELECT 1 FROM corner_brief_revisions pinned
           JOIN rooms active ON active.id=pinned.corner_id AND active.archived_at IS NULL
           CROSS JOIN LATERAL jsonb_array_elements(pinned.attachments) file
           WHERE file->>'objectId'=o.id::text
         ))
         AND (EXISTS (
           SELECT 1 FROM agent_pending_attachments p
           WHERE p.room_id=$3 AND p.agent_id=$4 AND p.request_id=$5 AND p.generation_id=$6
             AND o.owner_id=p.agent_id AND p.url LIKE '%/v1/media/' || o.id::text
         ) OR EXISTS (
           SELECT 1 FROM messages m,
             LATERAL jsonb_array_elements(m.attachments) a
           WHERE m.room_id=ANY($2::uuid[])
             AND m.author_id=o.owner_id
             AND (a->>'url' LIKE '%/v1/media/' || o.id::text
               OR a->>'mediaId'=o.id::text)
         )) FOR SHARE OF o`,
        [item.objectId, sourceRoomIds, pending?.roomId ?? null, pending?.agentId ?? null, pending?.requestId ?? null, pending?.generationId ?? null],
      )
    ).rows[0];
    if (!object)
      throw new Error(
        `corner brief attachment ${item.objectId} is missing or unavailable in this Room`,
      );
    resolved.push({
      objectId: item.objectId.toLowerCase(),
      title: object.title || item.objectId,
      purpose: item.purpose.trim(),
      required: item.required,
      mime: object.mime,
      sha256: object.sha256,
      size: Number(object.size),
    });
  }
  return resolved;
}

/** Planning artifacts posted in the same active turn are already durable
 * server objects but have not reached the turn's final message yet. Include
 * them in the assignment manifest automatically so an agent never has to copy
 * an opaque media UUID out of its own post_artifact call. */
export async function resolvePendingCornerBriefAttachments(
  db: SqlDatabase,
  input: {
    roomId: string;
    agentId: string;
    requestId: string;
    generationId?: string;
    excluding: readonly string[];
  },
): Promise<CornerBriefAttachment[]> {
  if (!input.generationId) return [];
  const rows = (
    await db.query<{
      object_id: string;
      title: string;
      mime: string;
      sha256: string;
      size: string;
    }>(
      `SELECT object.id::text object_id,COALESCE(object.title,pending.name) title,
              object.mime,object.sha256,object.size
       FROM agent_pending_attachments pending
       JOIN objects object ON object.owner_id=pending.agent_id
         AND pending.url LIKE '%/v1/media/' || object.id::text
       WHERE pending.room_id=$1 AND pending.agent_id=$2 AND pending.request_id=$3
         AND pending.generation_id=$4 AND object.state='ready' AND object.expires_at>now()
       ORDER BY pending.created_at,pending.url`,
      [input.roomId, input.agentId, input.requestId, input.generationId],
    )
  ).rows;
  const excluded = new Set(input.excluding.map((id) => id.toLowerCase()));
  return rows
    .filter((row) => !excluded.has(row.object_id.toLowerCase()))
    .map((row) => ({
      objectId: row.object_id.toLowerCase(),
      title: row.title,
      purpose: 'Planning artifact posted during brief preparation',
      required: true,
      mime: row.mime,
      sha256: row.sha256,
      size: Number(row.size),
    }));
}

/** Newest messages considered for the upgrade spec; older history is marked, never read. */
const UPGRADE_DISCUSSION_CANDIDATES = 200;
/** Room left after the discussion for the "omitted for length" note. */
const UPGRADE_NOTE_RESERVE = 128;

function upgradeSpecHead(request: string): string {
  return `## Request\n\n${request.trim()}\n\n## Discussion before the upgrade (context, not authority)\n`;
}

/** The longest triggering message whose request section still fits the spec cap. */
const UPGRADE_REQUEST_LENGTH =
  CORNER_BRIEF_SPEC_MAX_LENGTH - upgradeSpecHead('').length - UPGRADE_NOTE_RESERVE - 1;

function upgradeSpec(
  discussion: readonly { name: string; text: string }[],
  request: string,
  olderHistory: boolean,
): string {
  const head = upgradeSpecHead(request);
  const entries = discussion.map((row) => `\n- **${row.name}**: ${row.text.trim()}`);
  const kept: string[] = [];
  let remaining = CORNER_BRIEF_SPEC_MAX_LENGTH - head.length - UPGRADE_NOTE_RESERVE - 1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.length > remaining) continue;
    remaining -= entry.length;
    kept.unshift(entry);
  }
  const dropped = entries.length - kept.length;
  const note =
    dropped || olderHistory
      ? `\n- _${[dropped ? `${dropped} message(s)` : '', olderHistory ? 'earlier history' : '']
          .filter(Boolean)
          .join(' and ')} omitted for length._`
      : '';
  return `${head}${note}${kept.join('')}\n`;
}

/**
 * The brief a no-code corner gets the moment a person asks for code in it.
 *
 * Every other repository corner opens from a brief its agent typed before the
 * corner existed. This one is already a conversation, so the conversation IS
 * the assignment: the server composes it here, in the upgrade's own
 * transaction, rather than leaving the one repository corner that `createCorner`
 * would have refused — a code corner with no brief at all.
 *
 * The ONE explicit ask that triggered the upgrade is the request and the
 * approval. Everything said in the corner before it is carried below it as
 * context, because a chat corner holds abandoned and superseded asks that a
 * worker could not rank against the live one. The agent revises this
 * placeholder into a real spec with `revise_corner_brief`.
 */
export async function composeCornerUpgradeBrief(
  db: SqlDatabase,
  cornerId: string,
  request: { sourceMessageId: string; text: string },
): Promise<CornerBriefDraft> {
  if (!request.text.trim() || request.text.trim().length > UPGRADE_REQUEST_LENGTH)
    throw new Error(
      `corner lane upgrade needs the code request written in one message of at most ${UPGRADE_REQUEST_LENGTH} characters — ask again in a shorter message`,
    );
  // Newest first, bounded in rows AND in bytes per row: a message longer than
  // the whole spec can never be rendered, so reading past that length would
  // only be read to be thrown away.
  const candidates = (
    await db.query<{ id: string; text: string; name: string }>(
      `SELECT message.id,left(message.text,$2) text,identity.name
       FROM messages message JOIN identities identity ON identity.id=message.author_id
       WHERE message.room_id=$1 AND message.presentation='message'
         AND message.deleted_at IS NULL AND btrim(message.text)<>''
       ORDER BY message.created_at DESC,message.id DESC
       LIMIT $3`,
      [cornerId, CORNER_BRIEF_SPEC_MAX_LENGTH + 1, UPGRADE_DISCUSSION_CANDIDATES + 1],
    )
  ).rows;
  const olderHistory = candidates.length > UPGRADE_DISCUSSION_CANDIDATES;
  const discussion = candidates
    .slice(0, UPGRADE_DISCUSSION_CANDIDATES)
    .reverse()
    .filter((row) => row.id !== request.sourceMessageId);
  // Files posted in the discussion (a spec doc, a mock) reach the code agent
  // only through the brief: a turn downloads the brief's files, never an older
  // message's. The newest that are still available, in posting order.
  const files = (
    await db.query<{ object_id: string }>(
      `SELECT object_id FROM (
         SELECT DISTINCT ON (o.id) o.id::text object_id,message.created_at,message.id
         FROM messages message
         CROSS JOIN LATERAL jsonb_array_elements(message.attachments) a
         JOIN objects o ON o.owner_id=message.author_id
           AND (a->>'url' LIKE '%/v1/media/' || o.id::text OR a->>'mediaId'=o.id::text)
         WHERE message.room_id=$1 AND message.presentation='message'
           AND message.deleted_at IS NULL
           AND o.state='ready' AND o.expires_at>now()
         ORDER BY o.id,message.created_at DESC,message.id DESC
       ) posted
       ORDER BY created_at DESC,id DESC LIMIT $2`,
      [cornerId, CORNER_BRIEF_ATTACHMENT_LIMIT],
    )
  ).rows.reverse();
  return {
    spec: upgradeSpec(discussion, request.text, olderHistory),
    approval: { sourceMessageId: request.sourceMessageId },
    ...(files.length
      ? {
          attachments: files.map((file) => ({
            objectId: file.object_id,
            purpose: 'Posted in the corner discussion before the upgrade',
            required: false,
          })),
        }
      : {}),
  };
}

/**
 * Identity of one stored revision: what an `open_corner` retry is compared
 * against. Internal only; the contract no longer exposes it.
 */
export function cornerBriefRevisionHash(
  draft: CornerBriefDraft,
  attachments: readonly CornerBriefAttachment[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        spec: draft.spec.trim(),
        approval: draft.approval.sourceMessageId,
        attachments: attachments.map((attachment) => ({
          objectId: attachment.objectId,
          title: attachment.title,
          purpose: attachment.purpose,
          required: attachment.required,
          mime: attachment.mime,
          sha256: attachment.sha256,
          size: attachment.size,
        })),
      }),
    )
    .digest('hex');
}

/**
 * Stored `approval_basis` shape. Rows written before the trimmed brief carry
 * the same object, so old and new revisions read alike.
 */
type StoredCornerBriefApproval = {
  kind: 'initiating-command' | 'explicit-human-answer';
  sourceMessageId: string;
  /** The approving message's exact text when the revision was written. */
  snapshot: string;
  approvedBy: string;
  briefHash: string;
};

/**
 * Quote the human message that approved this spec. The agent names only the
 * message; its exact text and author come from the Room, and whether it was
 * the command that opened this work or a later answer is decided here.
 */
export async function resolveCornerBriefApproval(
  db: SqlDatabase,
  sourceRoomIds: readonly string[],
  draft: CornerBriefDraft,
  attachments: readonly CornerBriefAttachment[],
  initiatingMessageId?: string,
): Promise<{
  approvalBasis: StoredCornerBriefApproval;
  revisionHash: string;
  sourceRoomId: string;
}> {
  validateCornerBrief(draft);
  const sourceMessageId = draft.approval.sourceMessageId;
  const message = (
    await db.query<{ text: string; author_id: string; kind: string; room_id: string }>(
      `SELECT message.text,message.author_id,identity.kind,message.room_id
       FROM messages message JOIN identities identity ON identity.id=message.author_id
       WHERE message.room_id=ANY($1::uuid[]) AND message.id=$2`,
      [sourceRoomIds, sourceMessageId],
    )
  ).rows[0];
  if (!message || message.kind !== 'human')
    throw new Error('corner brief approval must name a human Room message');
  const revisionHash = cornerBriefRevisionHash(draft, attachments);
  return {
    approvalBasis: {
      kind:
        sourceMessageId === initiatingMessageId ? 'initiating-command' : 'explicit-human-answer',
      sourceMessageId,
      snapshot: message.text,
      approvedBy: message.author_id,
      briefHash: revisionHash,
    },
    revisionHash,
    sourceRoomId: message.room_id,
  };
}

/**
 * The one read of stored revisions. Callers append their own WHERE/ORDER on
 * the `brief` alias. The approver's name is joined here so every reader
 * shows the same attribution.
 */
export const CORNER_BRIEF_REVISION_SELECT = `SELECT brief.revision,brief.spec,brief.content,brief.intent_verbatim,
       brief.build_spec,brief.criteria,brief.non_goals,brief.brief_references,
       brief.approval_basis,brief.change,brief.author_id,brief.source_room_id,
       brief.source_message_id,brief.attachments,approver.name approver_name
FROM corner_brief_revisions brief
LEFT JOIN identities approver ON approver.id=brief.approval_basis->>'approvedBy'`;

/** Columns only revisions written before the trimmed brief carry. */
type FoldedBriefFields = {
  content: string | null;
  intent_verbatim: readonly { sourceMessageId: string; snapshot: string }[] | null;
  build_spec: string | null;
  criteria: readonly { id: string; text: string }[] | null;
  non_goals: readonly string[] | null;
  brief_references:
    | readonly { label: string; authority: string; description: string; objectId?: string }[]
    | null;
};

export type CornerBriefRow = FoldedBriefFields & {
  revision: number;
  spec: string | null;
  approval_basis: Partial<StoredCornerBriefApproval> | null;
  change: string | null;
  author_id: string;
  source_room_id: string;
  source_message_id: string | null;
  attachments: CornerBriefAttachment[];
  approver_name: string | null;
};

function quoteMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * One Markdown spec from a revision written before the trimmed brief. The
 * typed fields become headings in the order they used to render; empty ones
 * are skipped, and the old build spec (or the original opaque content) ends it.
 */
function foldCornerBriefSpec(row: FoldedBriefFields): string {
  const sections: string[] = [];
  if (row.intent_verbatim?.length)
    sections.push(
      `## Intent\n\n${row.intent_verbatim
        .map((item) => `${quoteMarkdown(item.snapshot)}\n>\n> — message \`${item.sourceMessageId}\``)
        .join('\n\n')}`,
    );
  if (row.criteria?.length)
    sections.push(
      `## Checklist\n\n${row.criteria.map((item) => `- ${item.id}: ${item.text}`).join('\n')}`,
    );
  if (row.non_goals?.length)
    sections.push(`## Non-goals\n\n${row.non_goals.map((item) => `- ${item}`).join('\n')}`);
  if (row.brief_references?.length)
    sections.push(
      `## References\n\n${row.brief_references
        .map(
          (item) =>
            `- ${item.label} [${item.authority}]: ${item.description}${
              item.objectId ? ` (object \`${item.objectId}\`)` : ''
            }`,
        )
        .join('\n')}`,
    );
  const buildSpec = (row.build_spec ?? row.content ?? '').trim();
  if (buildSpec) sections.push(buildSpec);
  return sections.join('\n\n');
}

export function projectCornerBrief(cornerId: string, row: CornerBriefRow): CornerBrief {
  const basis = row.approval_basis;
  return {
    id: cornerId,
    revision: row.revision,
    spec: row.spec ?? foldCornerBriefSpec(row),
    ...(basis?.sourceMessageId && basis.approvedBy
      ? {
          approval: {
            sourceMessageId: basis.sourceMessageId,
            text: basis.snapshot ?? '',
            approvedBy: basis.approvedBy,
            approverName: row.approver_name ?? basis.approvedBy,
          },
        }
      : {}),
    ...(row.change ? { change: row.change } : {}),
    authorId: row.author_id,
    sourceRoomId: row.source_room_id,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    attachments: row.attachments,
  };
}

export async function currentCornerBrief(
  db: SqlDatabase,
  cornerId: string,
): Promise<CornerBrief | undefined> {
  const row = (
    await db.query<CornerBriefRow>(
      `${CORNER_BRIEF_REVISION_SELECT}
       WHERE brief.corner_id=$1 ORDER BY brief.revision DESC LIMIT 1`,
      [cornerId],
    )
  ).rows[0];
  return row ? projectCornerBrief(cornerId, row) : undefined;
}
