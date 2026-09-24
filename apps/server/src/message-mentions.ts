import type { SqlDatabase } from './database.js';

const MENTION_TOKEN = /@([\p{L}\p{M}\p{N}_]+(?:[.-][\p{L}\p{M}\p{N}_]+)*)/gu;
const TOKEN_CHARACTER = /[\p{L}\p{M}\p{N}_.-]/u;
/**
 * The attribution line a forward ends with (`FORWARDED FROM #room · @author`).
 * It credits the original author; it does not address them, so its handle is
 * never read as a tag.
 */
const FORWARD_CAPTION = /\n\nFORWARDED FROM #[^\n]+$/;
const FORWARD_CAPTION_SQL = `'\\n\\nFORWARDED FROM #[^\\n]+$'`;

/**
 * `@channel` is not a handle: it is the one reserved broadcast token, read
 * through the SAME tokenizer path as an ordinary `@handle` (case-insensitive,
 * quoted lines excluded) but never resolved against a specific identity.
 * Written at write time (and re-read live, like every other tag) it expands
 * to every CURRENT human member of the effective Room — the parent Room for
 * a corner — excluding the author; agents are never in that set, so
 * `@channel` never routes to or wakes an agent.
 */
const CHANNEL_MENTION_HANDLE = 'channel';

export function isChannelMentionToken(handle: string): boolean {
  return handle.trim().toLowerCase() === CHANNEL_MENTION_HANDLE;
}

/** Whether the text addresses the whole Room via a live `@channel` token. */
export function hasChannelMention(text: string): boolean {
  for (const handle of typedMentionHandles(text)) if (isChannelMentionToken(handle)) return true;
  return false;
}

function codePointBefore(text: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const prefix = text.slice(0, offset);
  return [...prefix].at(-1);
}

function codePointAt(text: string, offset: number): string | undefined {
  return [...text.slice(offset)][0];
}

/** Exact @handles written as standalone tokens. */
export function typedMentionHandles(message: string): Set<string> {
  const text = message.replace(FORWARD_CAPTION, '');
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
  const resolved = [...typedHandles].flatMap((handle) => {
    const candidates = byHandle.get(handle);
    return candidates?.length === 1 ? candidates : [];
  });
  if (![...typedHandles].some(isChannelMentionToken)) return resolved;
  const seen = new Set(resolved.map((member) => member.id));
  for (const member of await resolveChannelMentionMembers(database, roomId, authorId)) {
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    resolved.push(member);
  }
  return resolved;
}

/**
 * Every current human member of `roomId`'s EFFECTIVE Room (its parent, for a
 * corner) excluding the author — the `@channel` expansion set. Read fresh
 * against live membership, same as every other mention; never an agent.
 */
async function resolveChannelMentionMembers(
  database: SqlDatabase,
  roomId: string,
  authorId?: string,
): Promise<ResolvedMessageMention[]> {
  const members = await database.query<{ id: string; handle: string }>(
    `SELECT identity.id,identity.handle
     FROM rooms room
     JOIN memberships membership ON membership.room_id=COALESCE(room.parent_id,room.id)
       AND membership.removed_at IS NULL
     JOIN identities identity ON identity.id=membership.identity_id AND identity.kind='human'
       AND identity.handle IS NOT NULL AND btrim(identity.handle)<>''
     WHERE room.id=$1 AND ($2::text IS NULL OR identity.id<>$2)`,
    [roomId, authorId ?? null],
  );
  return members.rows.map((row) => ({
    id: row.id,
    kind: 'human' as const,
    handle: row.handle.trim().replace(/^@/, ''),
  }));
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
  return `${withoutForwardCaptionSql(textExpr)} ~ ('(^|[^[:alnum:]_.-])@' ||
    regexp_replace(btrim(ltrim(${handleExpr},'@')),'([.-])','\\&','g') ||
    '[.-]*($|[^[:alnum:]_.-])')`;
}

/** The text a tag is read from: everything but a forward's attribution line. */
function withoutForwardCaptionSql(textExpr: string): string {
  return `regexp_replace(${textExpr},${FORWARD_CAPTION_SQL},'')`;
}

/** `handleWrittenIn`, pinned to the reserved `@channel` token, case-insensitive. */
function channelMentionWrittenSql(textExpr: string): string {
  return `${withoutForwardCaptionSql(textExpr)} ~* '(^|[^[:alnum:]_.-])@channel[.-]*($|[^[:alnum:]_.-])'`;
}

/**
 * Every current human member of a message's EFFECTIVE Room (its parent, for a
 * corner) reachable through its `@channel` token — the SQL twin of
 * `resolveChannelMentionMembers`. `message` is the SQL alias of the row being
 * read.
 */
function channelTaggedMembersSql(message: string): string {
  return `SELECT channel_member.identity_id
    FROM rooms channel_room
    JOIN memberships channel_member ON channel_member.room_id=COALESCE(channel_room.parent_id,channel_room.id)
      AND channel_member.removed_at IS NULL
    JOIN identities channel_identity ON channel_identity.id=channel_member.identity_id
      AND channel_identity.kind='human'
    WHERE channel_room.id=${message}.room_id
      AND ${message}.presentation NOT IN ('system','card')
      AND channel_member.identity_id<>${message}.author_id
      AND ${channelMentionWrittenSql(`${message}.text`)}`;
}

/**
 * The identities a message tags, read from its text and the Room's membership
 * AS IT STANDS — never from a snapshot taken when the message was written.
 *
 * A tag is therefore a live fact: renaming a handle, or removing the person it
 * named, changes who an old line reaches, and that is the intended meaning. A
 * message addresses whoever is in the Room under that handle now.
 *
 * Three rules ride along, each of them the durable behaviour the retired
 * stored-mention column used to carry:
 *  - the author never tags themself;
 *  - an ambiguous handle names NOBODY, rather than everyone who shares it;
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
    UNION
    ${channelTaggedMembersSql(message)}
  )`;
}

/**
 * Whether one already-resolved current Room member is tagged by a message.
 *
 * Delivery queries already know the candidate recipient. Rebuilding the full
 * Room tag array for every message/device pair multiplies regex work by the
 * whole roster. Keep the same ambiguity rule while testing only that known
 * identity.
 *
 * `identityKindExpr` gates the `@channel` branch: only a `'human'` identity
 * can be reached by the broadcast token, so an agent recipient (pass the
 * literal `'agent'`) never matches it and is never woken by `@channel`.
 */
export function tagsKnownIdentitySql(
  message: string,
  identityIdExpr: string,
  identityHandleExpr: string,
  identityKindExpr: string,
): string {
  return `(
    ${message}.presentation NOT IN ('system','card')
    AND (
      (
        ${identityHandleExpr} IS NOT NULL AND btrim(${identityHandleExpr})<>''
        AND ${handleWrittenIn(`${message}.text`, identityHandleExpr)}
        AND NOT EXISTS (
          SELECT 1 FROM memberships rival_member
          JOIN identities rival ON rival.id=rival_member.identity_id
          WHERE rival_member.room_id=${message}.room_id AND rival_member.removed_at IS NULL
            AND rival_member.identity_id<>${identityIdExpr}
            AND btrim(ltrim(rival.handle,'@'))=btrim(ltrim(${identityHandleExpr},'@'))
        )
      )
      OR (
        ${identityKindExpr}='human'
        AND ${identityIdExpr}<>${message}.author_id
        AND ${channelMentionWrittenSql(`${message}.text`)}
        AND EXISTS (
          SELECT 1 FROM rooms channel_room
          JOIN memberships channel_member
            ON channel_member.room_id=COALESCE(channel_room.parent_id,channel_room.id)
           AND channel_member.identity_id=${identityIdExpr}
           AND channel_member.removed_at IS NULL
          WHERE channel_room.id=${message}.room_id
        )
      )
    )
  )`;
}
