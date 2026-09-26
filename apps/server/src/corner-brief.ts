import { createHash } from 'node:crypto';
import type {
  CornerBrief,
  CornerBriefApprovalBasis,
  CornerBriefAttachment,
  CornerBriefDraft,
  CornerBriefReferenceAuthority,
  CornerBriefStructuredDraft,
  CornerValidationStageName,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRITERION_ID = /^[A-Z][A-Z0-9_-]*-[1-9][0-9]*$/;
const REFERENCE_AUTHORITIES = new Set<CornerBriefReferenceAuthority>([
  'human-authoritative',
  'repository-authoritative',
  'approved-reference',
  'informational',
  'agent-recommendation',
]);
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

export function isStructuredCornerBrief(
  draft: CornerBriefDraft,
): draft is CornerBriefStructuredDraft {
  return Boolean(draft && 'buildSpec' in draft);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
}

export function validateCornerBrief(
  draft: CornerBriefDraft,
  options: { allowLegacy?: boolean } = {},
): void {
  if (!draft || typeof draft !== 'object') throw new Error('corner brief is required');
  if (!isStructuredCornerBrief(draft)) {
    if (
      !options.allowLegacy ||
      !boundedText(draft.content, 65_536) ||
      (draft.change !== undefined &&
        (typeof draft.change !== 'string' || draft.change.length > 1_000))
    )
      throw new Error('new corner briefs require the structured authority contract');
  } else {
    if (!boundedText(draft.buildSpec, 65_536))
      throw new Error('corner brief buildSpec must contain 1–65536 characters');
    if (!Array.isArray(draft.intentVerbatim) || draft.intentVerbatim.length === 0)
      throw new Error('corner brief requires verbatim human intent');
    if (draft.intentVerbatim.length > 50)
      throw new Error('corner brief has too many verbatim intent entries');
    const intentIds = new Set<string>();
    for (const item of draft.intentVerbatim) {
      if (
        !item ||
        !boundedText(item.sourceMessageId, 256) ||
        !boundedText(item.snapshot, 16_000) ||
        intentIds.has(item.sourceMessageId)
      )
        throw new Error('invalid corner brief verbatim intent');
      intentIds.add(item.sourceMessageId);
    }
    if (!Array.isArray(draft.criteria) || draft.criteria.length === 0)
      throw new Error('corner brief requires numbered acceptance criteria');
    if (draft.criteria.length > 100) throw new Error('corner brief has too many criteria');
    const criterionIds = new Set<string>();
    for (const criterion of draft.criteria) {
      if (
        !criterion ||
        typeof criterion.id !== 'string' ||
        !CRITERION_ID.test(criterion.id) ||
        !boundedText(criterion.text, 2_000) ||
        criterionIds.has(criterion.id)
      )
        throw new Error('corner brief criteria require unique stable IDs such as AC-1');
      criterionIds.add(criterion.id);
    }
    if (!Array.isArray(draft.references) || draft.references.length > 50)
      throw new Error('corner brief references must be a bounded list');
    for (const reference of draft.references) {
      if (
        !reference ||
        !boundedText(reference.label, 200) ||
        !REFERENCE_AUTHORITIES.has(reference.authority) ||
        !boundedText(reference.description, 1_000) ||
        (reference.objectId !== undefined && !UUID.test(reference.objectId))
      )
        throw new Error('invalid corner brief reference');
    }
    if (
      draft.nonGoals !== undefined &&
      (!Array.isArray(draft.nonGoals) ||
        draft.nonGoals.length > 50 ||
        draft.nonGoals.some((item) => !boundedText(item, 1_000)))
    )
      throw new Error('invalid corner brief non-goals');
    const basis = draft.approvalBasis;
    if (
      !basis ||
      (basis.kind !== 'initiating-command' && basis.kind !== 'explicit-human-answer') ||
      !boundedText(basis.sourceMessageId, 256) ||
      !boundedText(basis.snapshot, 16_000)
    )
      throw new Error('corner brief requires a sourced approval basis');
    if (
      !draft.intentVerbatim.some(
        (item) =>
          item.sourceMessageId === basis.sourceMessageId && item.snapshot === basis.snapshot,
      )
    )
      throw new Error('corner brief approval basis must be retained in verbatim human intent');
    if (
      draft.change !== undefined &&
      (typeof draft.change !== 'string' || draft.change.length > 1_000)
    )
      throw new Error('corner brief change must be at most 1000 characters');
  }
  const attachments = draft.attachments;
  if (!Array.isArray(attachments) && attachments !== undefined)
    throw new Error('corner brief attachments must be a list');
  if ((attachments?.length ?? 0) > 16) throw new Error('corner brief has too many attachments');
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
  roomId: string,
  draft: CornerBriefDraft,
  options: { allowLegacy?: boolean } = {},
): Promise<CornerBriefAttachment[]> {
  validateCornerBrief(draft, options);
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
         AND EXISTS (
           SELECT 1 FROM messages m,
             LATERAL jsonb_array_elements(m.attachments) a
           WHERE m.room_id=$2
             AND m.author_id=o.owner_id
             AND (a->>'url' LIKE '%/v1/media/' || o.id::text
               OR a->>'mediaId'=o.id::text)
         ) FOR SHARE OF o`,
        [item.objectId, roomId],
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

const UPGRADE_INTENT_ENTRIES = 50;
const UPGRADE_SNAPSHOT_LENGTH = 16_000;
const UPGRADE_BUILD_SPEC_LENGTH = 65_536;
const UPGRADE_CRITERION_LENGTH = 2_000;

function upgradeCriterion(request: string): string {
  const text = `Deliver the code change this corner was asked for: ${request.replace(/\s+/g, ' ').trim()}`;
  return text.length <= UPGRADE_CRITERION_LENGTH
    ? text
    : `${text.slice(0, UPGRADE_CRITERION_LENGTH - 1)}…`;
}

function upgradeBuildSpec(
  discussion: readonly { name: string; text: string }[],
  request: string,
): string {
  const head = `# Code work requested in this corner\n\n## The request\n\n${request.trim()}\n\n## Discussion before the upgrade\n`;
  const entries = discussion.map((row) => `\n- **${row.name}**: ${row.text.trim()}`);
  const kept: string[] = [];
  let remaining = UPGRADE_BUILD_SPEC_LENGTH - head.length - 128;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.length > remaining) break;
    remaining -= entry.length;
    kept.unshift(entry);
  }
  const omitted = entries.length - kept.length;
  const note = omitted ? `\n- _${omitted} earlier message(s) omitted for length._` : '';
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
 */
export async function composeCornerUpgradeBrief(
  db: SqlDatabase,
  cornerId: string,
  approval: { sourceMessageId: string; snapshot: string },
): Promise<CornerBriefStructuredDraft> {
  const discussion = (
    await db.query<{ id: string; text: string; name: string; kind: string }>(
      `SELECT message.id,message.text,identity.name,identity.kind
       FROM messages message JOIN identities identity ON identity.id=message.author_id
       WHERE message.room_id=$1 AND message.presentation='message'
         AND message.deleted_at IS NULL AND btrim(message.text)<>''
       ORDER BY message.created_at,message.id`,
      [cornerId],
    )
  ).rows;
  const intentVerbatim = discussion
    .filter(
      (row) =>
        row.kind === 'human' &&
        row.id !== approval.sourceMessageId &&
        row.text.length <= UPGRADE_SNAPSHOT_LENGTH,
    )
    .slice(-(UPGRADE_INTENT_ENTRIES - 1))
    .map((row) => ({ sourceMessageId: row.id, snapshot: row.text }));
  intentVerbatim.push({
    sourceMessageId: approval.sourceMessageId,
    snapshot: approval.snapshot,
  });
  return {
    intentVerbatim,
    buildSpec: upgradeBuildSpec(discussion, approval.snapshot),
    criteria: [{ id: 'AC-1', text: upgradeCriterion(approval.snapshot) }],
    references: [],
    approvalBasis: {
      kind: 'initiating-command',
      sourceMessageId: approval.sourceMessageId,
      snapshot: approval.snapshot,
    },
  };
}

export function cornerBriefRevisionHash(
  draft: CornerBriefStructuredDraft,
  attachments: readonly CornerBriefAttachment[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        intentVerbatim: draft.intentVerbatim,
        buildSpec: draft.buildSpec.trim(),
        criteria: draft.criteria,
        nonGoals: draft.nonGoals ?? [],
        references: draft.references,
        approvalBasis: draft.approvalBasis,
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

export async function resolveCornerBriefApproval(
  db: SqlDatabase,
  sourceRoomIds: readonly string[],
  draft: CornerBriefStructuredDraft,
  attachments: readonly CornerBriefAttachment[],
  initiatingMessageId?: string,
): Promise<{
  approvalBasis: CornerBriefApprovalBasis;
  revisionHash: string;
  sourceRoomId: string;
}> {
  validateCornerBrief(draft);
  const entries = [
    ...draft.intentVerbatim.map((item) => ({ ...item, role: 'intent' as const })),
    { ...draft.approvalBasis, role: 'approval' as const },
  ];
  const rows = (
    await db.query<{ id: string; text: string; author_id: string; kind: string; room_id: string }>(
      `SELECT message.id,message.text,message.author_id,identity.kind,message.room_id
       FROM messages message JOIN identities identity ON identity.id=message.author_id
       WHERE message.room_id=ANY($1::uuid[]) AND message.id=ANY($2::text[])`,
      [sourceRoomIds, [...new Set(entries.map((entry) => entry.sourceMessageId))]],
    )
  ).rows;
  const messages = new Map(rows.map((row) => [row.id, row]));
  for (const entry of entries) {
    const message = messages.get(entry.sourceMessageId);
    if (!message || message.kind !== 'human' || message.text !== entry.snapshot)
      throw new Error(`corner brief ${entry.role} must quote an exact human Room message`);
  }
  if (
    draft.approvalBasis.kind === 'initiating-command' &&
    draft.approvalBasis.sourceMessageId !== initiatingMessageId
  )
    throw new Error('initiating-command approval must name the command that opened this work');
  const revisionHash = cornerBriefRevisionHash(draft, attachments);
  const approvalMessage = messages.get(draft.approvalBasis.sourceMessageId)!;
  return {
    approvalBasis: {
      ...draft.approvalBasis,
      approvedBy: approvalMessage.author_id,
      briefHash: revisionHash,
    },
    revisionHash,
    sourceRoomId: approvalMessage.room_id,
  };
}

type BriefRow = {
  revision: number;
  content: string;
  intent_verbatim: CornerBrief['intentVerbatim'] | null;
  build_spec: string | null;
  criteria: CornerBrief['criteria'] | null;
  non_goals: string[] | null;
  brief_references: CornerBrief['references'] | null;
  approval_basis: CornerBriefApprovalBasis | null;
  revision_hash: string | null;
  change: string | null;
  author_id: string;
  source_room_id: string;
  source_message_id: string | null;
  attachments: CornerBriefAttachment[];
};

export function projectCornerBrief(cornerId: string, row: BriefRow): CornerBrief {
  const buildSpec = row.build_spec ?? row.content;
  const legacyHash = createHash('sha256')
    .update(JSON.stringify({ content: row.content, attachments: row.attachments }))
    .digest('hex');
  const revisionHash = row.revision_hash ?? legacyHash;
  return {
    id: cornerId,
    revision: row.revision,
    content: buildSpec,
    legacy: row.revision_hash === null,
    intentVerbatim: row.intent_verbatim ?? [],
    buildSpec,
    criteria: row.criteria ?? [],
    nonGoals: row.non_goals ?? [],
    references: row.brief_references ?? [],
    approvalBasis: row.approval_basis ?? {
      kind: 'legacy-pre-migration',
      reason: 'This revision predates structured corner briefs.',
      briefHash: revisionHash,
    },
    revisionHash,
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
    await db.query<BriefRow>(
      `SELECT revision,content,intent_verbatim,build_spec,criteria,non_goals,
              brief_references,approval_basis,revision_hash,change,author_id,
              source_room_id,source_message_id,attachments
       FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
      [cornerId],
    )
  ).rows[0];
  return row ? projectCornerBrief(cornerId, row) : undefined;
}
