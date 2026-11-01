import { createHash } from 'node:crypto';
import {
  CORNER_BRIEF_SPEC_MAX_LENGTH,
  type CornerBrief,
  type CornerBriefAttachment,
  type CornerBriefDraft,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { commandOrder } from './commander.js';
import { CommandRefusalError, ExpectedRefusalError } from './command-refusal.js';

/** Most files one brief revision may carry. */
const CORNER_BRIEF_ATTACHMENT_LIMIT = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
}

export function validateCornerBrief(draft: CornerBriefDraft, repositoryBacked = false): readonly string[] {
  if (!draft || typeof draft !== 'object') throw new Error('corner brief is required');
  if (!boundedText(draft.spec, CORNER_BRIEF_SPEC_MAX_LENGTH))
    throw new Error(
      `corner brief spec must contain 1–${CORNER_BRIEF_SPEC_MAX_LENGTH} characters of Markdown`,
    );
  if (draft.approval !== undefined && !boundedText(draft.approval?.sourceMessageId, 256))
    throw new ExpectedRefusalError('corner brief approval must name a human Room message');
  if (
    draft.change !== undefined &&
    (typeof draft.change !== 'string' || draft.change.length > 1_000)
  )
    throw new Error('corner brief change must be at most 1000 characters');
  if (draft.repositoryWork !== undefined && typeof draft.repositoryWork !== 'boolean')
    throw new Error('corner brief repositoryWork must be a boolean');
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
  // Repository bugfixes record real-target proof, or why infeasible and the closest stand-in.
  const intent = draft.spec.match(/^## Intent\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mi)?.[1] ?? draft.spec;
  const bugfix = /\b(?:bugfix|bug fix|fix|repair|reported (?:bug|defect)|regression)\b/i.test(intent) &&
    !/\b(?:new feature|refactor|design only)\b|^[\s>"“]*(?:please\s+)?(?:add|create|build|design|feature)\b/i.test(intent);
  // Normalize emphasis on labels, preserving the surrounding section boundaries.
  const proofText = draft.spec.replace(
    /(\*{1,3}|_{1,3})((?:Reproduction(?: [a-z0-9_-]+| not feasible)?|Stand-in):?)\1/gi,
    '$2',
  );
  const reproduction = /(?:^|\n)\s*(?:[-*>]\s*)?(?:#{1,3}\s*)?Reproduction(?: [a-z0-9_-]+)?:\s*\S.+/i.test(proofText);
  const reproductionSection = proofText.split(/(?=^#{1,6}[ \t]+)/m).some(section =>
    /^#{1,6}[ \t]+Reproduction(?:[ \t]+[a-z0-9_-]+)?[ \t]*:?[ \t]*\n[\s\S]*\S/i.test(section) &&
    !/Reproduction not feasible/i.test(section),
  );
  const standIn = proofText.split(/(?=^#{1,6}[ \t]+)/m).some((section) =>
    /(?:^|\n)[ \t]*(?:[-*>][ \t]*)?Reproduction not feasible:[ \t]*\S[^\n]*?(?:[ \t;]+|\n[\s\S]*?)Stand-in:[ \t]*\S/i.test(section),
  );
  const identifiedStandIn = proofText.split(/(?=^#{1,6}[ \t]+)/m).some(section =>
    /(?:^|\n)[ \t]*(?:[-*>][ \t]*)?Reproduction[ \t]+(?!not[ \t]+feasible)[a-z0-9_-]+:?[ \t]*\n[ \t]*(?:[-*>][ \t]*)?Stand-in:[ \t]*\S/i.test(section),
  );
  return repositoryBacked && draft.repositoryWork !== false && bugfix && !reproduction && !reproductionSection && !standIn && !identifiedStandIn
    ? ['Repository bugfix brief needs Reproduction <id>: real-target steps and failure, or Reproduction not feasible: reason; Stand-in: closest check. Done repeats that check successfully.'] : [];
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
        ...(draft.repositoryWork !== undefined ? { repositoryWork: draft.repositoryWork } : {}),
        approval: draft.approval?.sourceMessageId,
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
  kind: 'agent-initiated' | 'initiating-command' | 'explicit-human-answer' | 'commander-order' | 'commander-direct';
  sourceMessageId: string;
  /** The approving message's exact text when the revision was written. */
  snapshot: string;
  approvedBy: string;
  briefHash: string;
  repositoryWork?: boolean;
  replyToMessageId?: string | null;
  replyToAttachmentIds?: readonly string[];
  replyToCreatedAt?: string | null;
  approvedAt?: string;
};

type ApprovingMessage = { text: string; author_id: string; kind: string; room_id: string };

/** A human may approve from the message's Room or the corner's Room. */
async function humanRoomMember(db: SqlDatabase, cornerId: string, roomId: string, personId: string): Promise<boolean> {
  return (await db.query(
    `SELECT 1 FROM effective_memberships member
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='human'
     WHERE member.room_id=ANY($1::uuid[]) AND member.identity_id=$2 AND member.removed_at IS NULL
     LIMIT 1`, [[cornerId, roomId], personId],
  )).rowCount > 0;
}

/** Later approvals may reuse a stored approval, a shared DM, or a commander order. */
async function laterCornerApproval(
  db: SqlDatabase,
  revision: { cornerId: string; agentId: string },
  sourceMessageId: string,
): Promise<
  | { stored: StoredCornerBriefApproval; sourceRoomId: string }
  | { message: ApprovingMessage; commanderOrder: boolean }
  | undefined
> {
  const current = (
    await db.query<{ approval_basis: Partial<StoredCornerBriefApproval> | null; source_room_id: string }>(
      `SELECT approval_basis,source_room_id FROM corner_brief_revisions
       WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
      [revision.cornerId],
    )
  ).rows[0];
  const stored = current?.approval_basis;
  if (
    stored?.sourceMessageId === sourceMessageId && stored.kind &&
    typeof stored.snapshot === 'string' && typeof stored.approvedBy === 'string' &&
    stored.kind !== 'commander-order' &&
    await humanRoomMember(db, revision.cornerId, current!.source_room_id, stored.approvedBy)
  )
    return { stored: stored as StoredCornerBriefApproval, sourceRoomId: current!.source_room_id };
  const direct = (
    await db.query<ApprovingMessage>(
      `SELECT message.text,message.author_id,identity.kind,message.room_id
       FROM messages message JOIN identities identity ON identity.id=message.author_id
       JOIN rooms dm ON dm.id=message.room_id AND dm.direct_participants IS NOT NULL
       JOIN effective_memberships member ON member.room_id=dm.id AND member.identity_id=$2
         AND member.removed_at IS NULL
       JOIN effective_memberships author ON author.room_id=dm.id AND author.identity_id=message.author_id
         AND author.removed_at IS NULL
       WHERE message.id=$1 AND identity.kind='human'`,
      [sourceMessageId, revision.agentId],
    )
  ).rows[0];
  if (direct) return { message: direct, commanderOrder: false };
  // Resolve transcript cards through their server-derived command identity, never their text.
  const order = (
    await db.query<CommandRow>(
      `SELECT command.* FROM agent_commands command JOIN rooms corner ON corner.id=command.room_id
       WHERE command.room_id=$2 AND command.agent_id=$3 AND command.state IN ('pending','claimed')
         AND command.private_payload->>'kind'='order'
         AND command.private_payload->>'authorId'=corner.created_by
         AND (command.id=$1 OR EXISTS (
           SELECT 1 FROM messages card WHERE card.id=$1 AND card.room_id=command.room_id
             AND card.card_type='agent-command' AND card.card->>'kind'='order'
             AND card.id=encode(sha256(convert_to('agent-command-card:' || command.id,'UTF8')),'hex')
         ))`,
      [sourceMessageId, revision.cornerId, revision.agentId],
    )
  ).rows[0];
  if (!order?.private_payload) return undefined;
  return {
    message: { text: order.private_payload.text, author_id: order.private_payload.authorId, room_id: order.room_id, kind: 'agent' },
    commanderOrder: true,
  };
}

/**
 * Quote the human message that approved this spec. The agent names only the
 * message; its exact text and author come from the Room, and whether it was
 * the command that opened this work or a later answer is decided here.
 * A revision of an existing corner also accepts the later approvals in
 * `laterCornerApproval`.
 */
export async function resolveCornerBriefApproval(
  db: SqlDatabase,
  sourceRoomIds: readonly string[],
  draft: CornerBriefDraft,
  attachments: readonly CornerBriefAttachment[],
  initiatingMessageId?: string,
  revision?: { cornerId: string; agentId: string },
  opening?: { agentId: string; roomId: string },
  humanCitation?: { agentId: string },
): Promise<{
  approvalBasis: StoredCornerBriefApproval;
  revisionHash: string;
  sourceRoomId: string;
}> {
  if (revision && !draft.approval) {
    const commander = (await db.query<{ parent_id: string }>(
      `SELECT parent_id FROM rooms WHERE id=$1 AND created_by=$2`,
      [revision.cornerId, revision.agentId],
    )).rows[0];
    if (commander) {
      const directDraft = { ...draft, approval: undefined };
      validateCornerBrief(directDraft);
      const revisionHash = cornerBriefRevisionHash(directDraft, attachments);
      return {
        approvalBasis: { kind: 'commander-direct', sourceMessageId: '',
          snapshot: 'Commander revised the corner brief directly', approvedBy: revision.agentId,
          briefHash: revisionHash,
          ...(draft.repositoryWork !== undefined ? { repositoryWork: draft.repositoryWork } : {}) },
        revisionHash, sourceRoomId: commander.parent_id,
      };
    }
  }
  if (!humanCitation) validateCornerBrief(draft);
  if (revision && !draft.approval)
    throw new CommandRefusalError('corner brief approval must name a human message or commander order', 403);
  let sourceMessageId = draft.approval?.sourceMessageId ?? '';
  const initiating = sourceMessageId === initiatingMessageId;
  // Holds use this same message resolver, with live human/readability checks and
  // no stored-approval or commander-order fallback.
  const cited = (await db.query<ApprovingMessage & {
    deleted_at: string | null; hidden_from_roster: boolean;
    presentation: string; system_event: unknown; readable: boolean;
  }>(
    `SELECT message.text,message.author_id,identity.kind,message.room_id,
            message.deleted_at,identity.hidden_from_roster,message.presentation,message.system_event,
            EXISTS (SELECT 1 FROM effective_memberships member
              WHERE member.room_id=message.room_id AND member.identity_id=$3
                AND member.removed_at IS NULL) readable
     FROM messages message JOIN identities identity ON identity.id=message.author_id
     WHERE message.id=$2 AND ($4::boolean OR message.room_id=ANY($1::uuid[]))`,
    [sourceRoomIds, sourceMessageId, humanCitation?.agentId ?? null, Boolean(humanCitation)],
  )).rows[0];
  if (humanCitation) {
    const failure = !sourceMessageId ? 'sourceMessageId is required' : !cited ? 'cited message does not exist' :
      cited.deleted_at ? 'cited message is deleted' :
      cited.kind !== 'human' || cited.hidden_from_roster || cited.presentation !== 'message' || cited.system_event
        ? 'cited author must be a person, not an agent or System' :
      !cited.readable ? 'calling agent cannot read the cited message' : undefined;
    if (failure) throw new CommandRefusalError(`${failure}; cite the person's message that asks for the hold, or close the PR to stop it.`, 403);
    return {
      approvalBasis: { kind: 'explicit-human-answer', sourceMessageId,
        snapshot: cited!.text, approvedBy: cited!.author_id, briefHash: '' },
      revisionHash: '', sourceRoomId: cited!.room_id,
    };
  }
  let message: ApprovingMessage | undefined = cited;
  let commanderOrder = false;
  if (!message && initiating && !revision) {
    const active = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [sourceMessageId])).rows[0];
    const order = active ? await commandOrder(db, active) : undefined;
    if (order?.private_payload?.kind === 'order' && sourceRoomIds.includes(order.room_id)) {
      sourceMessageId = order.id;
      message = { text: order.private_payload.text, author_id: order.private_payload.authorId, room_id: order.room_id, kind: 'agent' };
      commanderOrder = true;
    } else if (order?.source_message_id) {
      sourceMessageId = order.source_message_id;
      message = (await db.query<{ text: string; author_id: string; kind: string; room_id: string }>(
        `SELECT message.text,message.author_id,identity.kind,message.room_id FROM messages message
         JOIN identities identity ON identity.id=message.author_id
         WHERE message.id=$1 AND message.room_id=ANY($2::uuid[])`, [sourceMessageId, sourceRoomIds],
      )).rows[0];
    }
  }
  // Human approvals require current membership in the corner or source Room.
  if (revision && message?.kind === 'human' && !(await humanRoomMember(db, revision.cornerId, message.room_id, message.author_id)))
    message = undefined;
  if (revision && (!message || message.kind !== 'human' && !commanderOrder)) {
    const later = await laterCornerApproval(db, revision, sourceMessageId);
    if (later && 'stored' in later) {
      const revisionHash = cornerBriefRevisionHash(draft, attachments);
      const { repositoryWork: _previous, ...stored } = later.stored;
      return {
        approvalBasis: {
          ...stored,
          briefHash: revisionHash,
          ...(draft.repositoryWork !== undefined ? { repositoryWork: draft.repositoryWork } : {}),
        },
        revisionHash,
        sourceRoomId: later.sourceRoomId,
      };
    }
    if (later) {
      sourceMessageId = draft.approval!.sourceMessageId;
      ({ message, commanderOrder } = later);
    }
  }
  if (revision && (!message || message.kind !== 'human' && !commanderOrder))
    throw new CommandRefusalError('corner brief approval must name a human message or commander order; the human author must be a current Room member', 403);
  if (opening && !revision && (!message || message.kind !== 'human' && !commanderOrder)) {
    const revisionHash = cornerBriefRevisionHash(draft, attachments);
    return {
      approvalBasis: { kind: 'agent-initiated', sourceMessageId,
        snapshot: 'Agent-initiated corner', approvedBy: opening.agentId, briefHash: revisionHash,
        ...(draft.repositoryWork !== undefined ? { repositoryWork: draft.repositoryWork } : {}) },
      revisionHash, sourceRoomId: opening.roomId,
    };
  }
  if (!message || message.kind !== 'human' && !commanderOrder)
    throw new CommandRefusalError('corner brief approval must name a human message or commander order', 403);
  // Evidence only: retain the reply's file provenance without exposing the DM
  // or participating in merge authorization.
  const evidence = message.kind === 'human' ? (await db.query<{
    replyToMessageId: string | null; replyToAttachmentIds: string[];
    replyToCreatedAt: string | null; approvedAt: string;
  }>(
    `SELECT approval.reply_to_message_id AS "replyToMessageId",
            COALESCE((SELECT jsonb_agg(DISTINCT file_id) FROM (
              SELECT COALESCE(file->>'mediaId',
                substring(file->>'url' FROM '/v1/media/([0-9a-fA-F-]{36})')) file_id
              FROM jsonb_array_elements(COALESCE(mock.attachments,'[]'::jsonb)) file
            ) files WHERE file_id IS NOT NULL), '[]'::jsonb) AS "replyToAttachmentIds",
            mock.created_at::text AS "replyToCreatedAt", approval.created_at::text AS "approvedAt"
     FROM messages approval LEFT JOIN messages mock
       ON mock.id=approval.reply_to_message_id AND mock.room_id=approval.room_id
     WHERE approval.id=$1`, [sourceMessageId],
  )).rows[0] : undefined;
  const revisionHash = cornerBriefRevisionHash(draft, attachments);
  return {
    approvalBasis: {
      ...evidence,
      kind:
        message.kind === 'agent' ? 'commander-order' : initiating ? 'initiating-command' : 'explicit-human-answer',
      sourceMessageId,
      snapshot: message.text,
      approvedBy: message.author_id,
      briefHash: revisionHash,
      ...(draft.repositoryWork !== undefined ? { repositoryWork: draft.repositoryWork } : {}),
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
  author_handle?: string | null;
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
    ...(basis?.repositoryWork !== undefined ? { repositoryWork: basis.repositoryWork } : {}),
    ...((basis?.sourceMessageId || basis?.kind === 'commander-direct') && basis.approvedBy
      ? {
          approval: {
            ...(basis.kind ? { kind: basis.kind } : {}),
            ...(basis.replyToMessageId !== undefined ? { replyToMessageId: basis.replyToMessageId } : {}),
            ...(basis.replyToAttachmentIds !== undefined ? { replyToAttachmentIds: basis.replyToAttachmentIds } : {}),
            ...(basis.replyToCreatedAt !== undefined ? { replyToCreatedAt: basis.replyToCreatedAt } : {}),
            ...(basis.approvedAt !== undefined ? { approvedAt: basis.approvedAt } : {}),
            sourceMessageId: basis.sourceMessageId ?? '',
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

/** What every land attempt answers when the corner's brief does not assign repository work. */
export const CORNER_BRIEF_MERGE_REFUSAL =
  "this corner's brief does not assign repository work; revise the brief before merging";

/** Thrown by the one merge path (`GitHubOperations.landCorner`); never swallowed by its callers. */
export class CornerBriefMergeRefusedError extends Error {
  constructor() {
    super(CORNER_BRIEF_MERGE_REFUSAL);
    this.name = 'CornerBriefMergeRefusedError';
  }
}

/**
 * The brief half of the merge gate. A corner lands only when its current brief
 * assigns repository work: a corner with no brief revision, or whose current
 * revision says `repositoryWork: false`, is refused. A revision written before
 * `repositoryWork` existed (undefined) is allowed. Only the land is gated; a
 * reviewer's PASS or a person's yes is still recorded.
 */
export async function assertCornerBriefAllowsMerge(db: SqlDatabase, cornerId: string): Promise<void> {
  const brief = await currentCornerBrief(db, cornerId);
  if (!brief || brief.repositoryWork === false) throw new CornerBriefMergeRefusedError();
}
