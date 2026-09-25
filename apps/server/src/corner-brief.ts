import type {
  CornerBrief,
  CornerBriefDraft,
  CornerBriefAttachment,
  CornerValidationStageName,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

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

export function validateCornerBrief(draft: CornerBriefDraft): void {
  if (
    !draft ||
    typeof draft.content !== 'string' ||
    !draft.content.trim() ||
    draft.content.length > 65_536
  )
    throw new Error('corner brief must contain 1–65536 characters');
  if (
    draft.change !== undefined &&
    (typeof draft.change !== 'string' || draft.change.length > 1_000)
  )
    throw new Error('corner brief change must be at most 1000 characters');
  if (!Array.isArray(draft.attachments) && draft.attachments !== undefined)
    throw new Error('corner brief attachments must be a list');
  if ((draft.attachments?.length ?? 0) > 16)
    throw new Error('corner brief has too many attachments');
  const ids = new Set<string>();
  for (const item of draft.attachments ?? []) {
    if (
      !item ||
      typeof item.objectId !== 'string' ||
      !UUID.test(item.objectId) ||
      typeof item.purpose !== 'string' ||
      !item.purpose.trim() ||
      item.purpose.length > 500 ||
      typeof item.required !== 'boolean' ||
      ids.has(item.objectId)
    )
      throw new Error('invalid corner brief attachment');
    ids.add(item.objectId);
  }
}

export async function resolveCornerBriefAttachments(
  db: SqlDatabase,
  roomId: string,
  draft: CornerBriefDraft,
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

export async function currentCornerBrief(
  db: SqlDatabase,
  cornerId: string,
): Promise<CornerBrief | undefined> {
  const row = (
    await db.query<{
      revision: number;
      content: string;
      change: string | null;
      author_id: string;
      source_room_id: string;
      source_message_id: string | null;
      attachments: CornerBriefAttachment[];
    }>(
      `SELECT revision,content,change,author_id,source_room_id,source_message_id,attachments
     FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
      [cornerId],
    )
  ).rows[0];
  return row
    ? {
        id: cornerId,
        revision: row.revision,
        content: row.content,
        ...(row.change ? { change: row.change } : {}),
        authorId: row.author_id,
        sourceRoomId: row.source_room_id,
        ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
        attachments: row.attachments,
      }
    : undefined;
}
