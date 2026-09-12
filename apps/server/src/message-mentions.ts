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

/**
 * `typedMentionHandles`, written as a SQL predicate against one known handle.
 *
 * The two readings must agree, because the same tag decides routing in
 * TypeScript (`resolveCurrentMemberMentions`, on write) and delivery in SQL
 * (push fan-out, helper wake, highlight). So the boundaries are the same ones:
 * the `@` may not sit inside a word, and a trailing `.` or `-` is punctuation
 * rather than part of the handle — `@ada.` names Ada, `@ada.b` does not.
 *
 * Only `.` and `-` need escaping; a handle is otherwise letters, digits and
 * underscores, none of which are pattern operators.
 */
function handleWrittenIn(textExpr: string, handleExpr: string): string {
  return `${textExpr} ~ ('(^|[^[:alnum:]_.-])@' ||
    regexp_replace(btrim(ltrim(${handleExpr},'@')),'([.-])','\\&','g') ||
    '[.-]*($|[^[:alnum:]_.-])')`;
}

/**
 * The identities a message tags, read from its text and the Room's membership
 * AS IT STANDS — never from a snapshot taken when the message was written.
 *
 * A tag is therefore a live fact: renaming a handle, or removing the person it
 * named, changes who an old line reaches, and that is the intended meaning. A
 * message addresses whoever is in the Room under that handle now.
 *
 * Four rules ride along, each of them the durable behaviour the retired
 * stored-mention column used to carry:
 *  - the author never tags themself;
 *  - an ambiguous handle names NOBODY, rather than everyone who shares it;
 *  - a corner agent's turn reply never tags a person, because the merge
 *    summary card and its push already say the work is done;
 *  - a system line tags nobody at all. Its sentence names people as GRAMMAR —
 *    `@greeter did not answer @ada · only @bee may address @greeter` names
 *    three handles and is addressed to none of them. A system line reaches
 *    agents through the explicit wake list the server passes it
 *    (`system-line.ts`), and a person through the card rules in
 *    `background.ts`; reading its display text as an address would push a
 *    refusal to everybody it happened to mention by name.
 *
 * `message` is the SQL alias of the `messages` row being read.
 */
export function taggedIdentityIdsSql(message: string): string {
  return `ARRAY(
    SELECT tagged_member.identity_id
    FROM memberships tagged_member
    JOIN identities tagged ON tagged.id=tagged_member.identity_id
    WHERE ${message}.presentation NOT IN ('system','card')
      AND tagged_member.room_id=${message}.room_id AND tagged_member.removed_at IS NULL
      AND tagged_member.identity_id<>${message}.author_id
      AND tagged.handle IS NOT NULL AND btrim(tagged.handle)<>''
      AND ${handleWrittenIn(`${message}.text`, 'tagged.handle')}
      AND NOT EXISTS (
        SELECT 1 FROM memberships rival_member
        JOIN identities rival ON rival.id=rival_member.identity_id
        WHERE rival_member.room_id=tagged_member.room_id AND rival_member.removed_at IS NULL
          AND rival_member.identity_id<>tagged_member.identity_id
          AND btrim(ltrim(rival.handle,'@'))=btrim(ltrim(tagged.handle,'@'))
      )
      AND NOT (
        tagged.kind='human' AND ${message}.request_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM identities reply_author
                   WHERE reply_author.id=${message}.author_id AND reply_author.kind='agent')
        AND EXISTS(SELECT 1 FROM corner_facts WHERE corner_facts.corner_id=${message}.room_id)
      )
  )`;
}

/** Whether `message` tags `identityExpr`, by the same reading as `taggedIdentityIdsSql`. */
export function tagsIdentitySql(message: string, identityExpr: string): string {
  return `${identityExpr} = ANY(${taggedIdentityIdsSql(message)})`;
}
