import type { SqlDatabase } from './database.js';

const MENTION_TOKEN = /@([\p{L}\p{M}\p{N}_]+(?:[.-][\p{L}\p{M}\p{N}_]+)*)/gu;
const TOKEN_CHARACTER = /[\p{L}\p{M}\p{N}_.-]/u;

function codePointBefore(text: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const prefix = text.slice(0, offset);
  return [...prefix].at(-1);
}

function codePointAt(text: string, offset: number): string | undefined {
  return [...text.slice(offset)][0];
}

/** Exact @handles written as standalone tokens. */
export function typedMentionHandles(text: string): Set<string> {
  const handles = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const offset = match.index ?? 0;
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    // Quoted transcript is attribution, not a fresh address. Forwarded and
    // manually quoted messages must never wake the people or agents they quote.
    if (/^\s*>/.test(text.slice(lineStart, offset))) continue;
    const before = codePointBefore(text, offset);
    const punctuation = text.slice(offset + match[0].length).match(/^[.-]+/u)?.[0];
    const afterPunctuation = punctuation
      ? codePointAt(text, offset + match[0].length + punctuation.length)
      : undefined;
    if (
      (!before || !TOKEN_CHARACTER.test(before)) &&
      (!afterPunctuation || !TOKEN_CHARACTER.test(afterPunctuation))
    )
      handles.add(match[1] ?? '');
  }
  return handles;
}

export interface ResolvedMessageMention {
  readonly id: string;
  readonly kind: 'human' | 'agent';
  readonly handle: string;
}

/** Resolve exact typed handles against the Room's current membership. */
export async function resolveCurrentMemberMentions(
  database: SqlDatabase,
  roomId: string,
  text: string,
  authorId?: string,
): Promise<ResolvedMessageMention[]> {
  const typedHandles = typedMentionHandles(text);
  if (!typedHandles.size) return [];
  const members = await database.query<{
    id: string;
    kind: 'human' | 'agent';
    handle: string;
  }>(
    `SELECT identity.id,identity.kind,identity.handle
     FROM memberships membership
     JOIN identities identity ON identity.id=membership.identity_id
     WHERE membership.room_id=$1 AND membership.removed_at IS NULL
       AND identity.handle IS NOT NULL AND btrim(identity.handle)<>''`,
    [roomId],
  );
  const byHandle = new Map<string, ResolvedMessageMention[]>();
  for (const member of members.rows) {
    if (member.id === authorId) continue;
    const handle = member.handle.trim().replace(/^@/, '');
    const candidates = byHandle.get(handle) ?? [];
    candidates.push({ id: member.id, kind: member.kind, handle });
    byHandle.set(handle, candidates);
  }
  return [...typedHandles].flatMap((handle) => {
    const candidates = byHandle.get(handle);
    return candidates?.length === 1 ? candidates : [];
  });
}
