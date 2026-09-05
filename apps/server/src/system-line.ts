import { randomBytes } from 'node:crypto';
import {
  MAX_EVENT_DEPTH,
  MAX_TURNS_PER_ROOT,
  eventBudgetRefusal,
  eventDepthRefusal,
  formatSystemLine,
  type SystemEvent,
  type SystemEventKind,
  type SystemObject,
  type SystemSubject,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

/**
 * The one producer of every system notification in a Room.
 *
 * Every membership note, yolo change, grant line, failed turn, GitHub fact,
 * corner marker, scheduled prompt and card header is phrased HERE, in one
 * grammar (`@beeline/api-contract` `system-events.ts`): `<subject> <verb>
 * [ <object>][ · <consequence>]`. The stored text is what an old phone shows
 * verbatim; the structured `messages.system_event` beside it is what a current
 * phone renders (names as tappable mentions, the object linked by its URL,
 * same-verb runs folded). The daemon never phrases a line: it posts events and
 * the server calls this. `system-line.contract.test.ts` fails the build on any
 * `presentation='system'` insert or any text restatement outside this file.
 *
 * A line is the default container. A card (`presentation: 'card'`) is only for
 * something a tap must settle — a grant request, a permission ask, the merge
 * summary with its pull-request link — and keeps its own component on the
 * phone; its header sentence still comes from here.
 */
export interface SystemLineInput {
  readonly roomId: string;
  /** The row's author; drives the daemon inbox filter and push exclusions. Defaults to the subject id. */
  readonly authorId?: string;
  /** A deterministic id makes the insert idempotent (`ON CONFLICT DO NOTHING`). */
  readonly id?: string;
  readonly subject: SystemSubject;
  readonly verb: string;
  /**
   * What this line IS. A producer says the kind and nothing else: the
   * subscriber fill below turns it into mentions, in one place. A line with no
   * kind is one nothing subscribes to.
   */
  readonly kind?: SystemEventKind;
  readonly object?: string | SystemObject;
  readonly consequence?: string;
  /** Identities to mention: the only thing that makes a line push or wake a daemon. */
  readonly mentions?: readonly string[];
  readonly presentation?: 'system' | 'card';
  readonly cardType?: string;
  readonly card?: Record<string, unknown>;
  readonly requestId?: string;
  readonly durableFact?: 'failure' | 'merge' | 'action';
  /**
   * The message this line is a consequence of, when it is one.
   *
   * Passed only by the server, from a fact the server read itself — an agent's
   * active turn receipt, never a value a helper sent. A line with a cause is
   * part of a cascade: it inherits that cause's root, sits one deeper, and is
   * refused when the cascade has run too deep or woken too many turns. A line
   * with a kind and no cause is the ROOT of its own cascade at depth 0, and is
   * never refused — a join must not be lost to a guard meant for agents.
   */
  readonly causeId?: string;
}

/**
 * The cascade bounds, refused at write time. Carries the sentence an agent
 * reads: `postRoomEvent` lets it out of the operation so the emitting tool
 * shows it verbatim, and nothing is written.
 */
export class EventCascadeRefusedError extends Error {
  override readonly name = 'EventCascadeRefusedError';
}

export interface SystemLineResult {
  readonly id: string;
  readonly text: string;
  readonly event: SystemEvent;
  /** False when a deterministic id already existed. */
  readonly inserted: boolean;
}

export type SystemPhrase = Pick<
  SystemLineInput,
  'subject' | 'verb' | 'object' | 'consequence' | 'kind'
>;

const CLEAN = /[\s ]+/g;

function clause(value: string): string {
  return value.replace(CLEAN, ' ').trim();
}

/** The text and the structured event for one phrase; pure, so tests can pin both. */
export function composeSystemLine(phrase: SystemPhrase): { text: string; event: SystemEvent } {
  const object: SystemObject | undefined =
    phrase.object === undefined
      ? undefined
      : typeof phrase.object === 'string'
        ? { text: clause(phrase.object) }
        : { ...phrase.object, text: clause(phrase.object.text) };
  const consequence = phrase.consequence ? clause(phrase.consequence) : undefined;
  const event: SystemEvent = {
    subject: { ...phrase.subject, name: clause(phrase.subject.name) },
    verb: clause(phrase.verb),
    ...(object && object.text ? { object } : {}),
    ...(consequence ? { consequence } : {}),
    ...(phrase.kind ? { kind: phrase.kind } : {}),
  };
  // The kind never reaches the text: `formatSystemLine` reads subject, verb,
  // object and consequence, so a line's wording is exactly what it was before
  // it carried a kind.
  return { text: formatSystemLine(event), event };
}

/**
 * The agent members of this Room that subscribed to `kind`.
 *
 * One query, one place: a producer says the kind, never who cares about it.
 * Rooms hold tens of agents, so no index is needed yet — when a Room holds
 * hundreds, this is the query that wants a GIN index on `event_subscriptions`.
 *
 * A failure here must never take the caller down with it: the join that posts
 * the line is a real membership write, and losing it to a subscription lookup
 * would be a silent partial join. So the lookup is caught and logged, and the
 * line is still written with whatever mentions the producer named explicitly.
 * The residual limit, stated plainly: PostgreSQL aborts a transaction on a
 * failed statement, so a caller that passes its own transaction handle is
 * still lost if THIS query is what failed inside it. The catch covers every
 * caller that passes the pool, and every failure that is not the statement
 * itself. Keeping the query trivial — one indexed predicate over a column the
 * migration creates — is what keeps that case theoretical.
 */
async function subscribers(
  database: SqlDatabase,
  roomId: string,
  kind: SystemEventKind | undefined,
): Promise<string[]> {
  if (!kind) return [];
  try {
    const rows = await database.query<{ identity_id: string }>(
      `SELECT member.identity_id FROM memberships member
       JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
       WHERE member.room_id=$1 AND member.removed_at IS NULL
         AND member.event_subscriptions @> $2::jsonb`,
      [roomId, JSON.stringify([kind])],
    );
    return rows.rows.map((row) => row.identity_id);
  } catch (error) {
    console.error('[system-line] subscriber lookup failed', roomId, kind, error);
    return [];
  }
}

type Cascade = { causeId: string | null; rootCauseId: string; depth: number };

/**
 * Where this line sits in its cascade, and whether the cascade may grow.
 *
 * The depth and the root are DERIVED from the cause row the server reads here;
 * neither is ever accepted from a caller, because the party a guard binds must
 * not be the party that sets it. The count is serialised per root with
 * `pg_advisory_xact_lock(hashtext(root))`: counting and then inserting races,
 * and two emitters that each see eleven would otherwise both write the twelfth.
 * The lock is per root, so unrelated Rooms never wait on each other, and it is
 * released by the transaction that took it.
 */
async function resolveCascade(
  database: SqlDatabase,
  causeId: string,
  mentionCount: number,
): Promise<Cascade> {
  const cause = await database.query<{
    event_root_cause_id: string | null;
    event_depth: number | null;
  }>(`SELECT event_root_cause_id,event_depth FROM messages WHERE id=$1`, [causeId]);
  const row = cause.rows[0];
  if (!row) {
    throw new EventCascadeRefusedError(
      'the message that caused this turn is no longer in the Room, so this event has nothing to cite; nothing was posted',
    );
  }
  const rootCauseId = row.event_root_cause_id ?? causeId;
  const depth = (row.event_depth ?? 0) + 1;
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [rootCauseId]);
  if (depth > MAX_EVENT_DEPTH) throw new EventCascadeRefusedError(eventDepthRefusal(depth));
  const spent = await database.query<{ woken: number }>(
    `SELECT COALESCE(SUM(jsonb_array_length(mention_ids)),0)::int woken
     FROM messages WHERE event_root_cause_id=$1`,
    [rootCauseId],
  );
  const woken = spent.rows[0]?.woken ?? 0;
  if (woken + mentionCount > MAX_TURNS_PER_ROOT)
    throw new EventCascadeRefusedError(eventBudgetRefusal(woken));
  return { causeId, rootCauseId, depth };
}

/** Insert one system line (or card) in a Room. */
export async function systemLine(
  database: SqlDatabase,
  input: SystemLineInput,
): Promise<SystemLineResult> {
  const { text, event } = composeSystemLine(input);
  const id = input.id ?? randomBytes(32).toString('hex');
  const authorId = input.authorId ?? input.subject.id;
  if (!authorId) throw new Error('system line needs an author identity');
  const mentions = [
    ...new Set([
      ...(input.mentions ?? []),
      ...(await subscribers(database, input.roomId, input.kind)),
    ]),
  ];
  // Only an event carries a cascade. A line with no kind is one nothing reacts
  // to, so it has no root to belong to and no budget to spend.
  const write = async (db: SqlDatabase, cascade: Cascade | undefined) => {
    const result = await db.query(
      `INSERT INTO messages(
         id,room_id,author_id,text,presentation,mention_ids,request_id,durable_fact,
         card_type,card,system_event,event_cause_id,event_root_cause_id,event_depth
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)
       ON CONFLICT(id) DO NOTHING`,
      [
        id,
        input.roomId,
        authorId,
        text,
        input.presentation ?? 'system',
        JSON.stringify(mentions),
        input.requestId ?? null,
        input.durableFact ?? null,
        input.cardType ?? null,
        input.card ? JSON.stringify(input.card) : null,
        JSON.stringify(event),
        cascade?.causeId ?? null,
        cascade?.rootCauseId ?? null,
        cascade?.depth ?? null,
      ],
    );
    return { id, text, event, inserted: Boolean(result.rowCount) };
  };
  if (!input.kind) return write(database, undefined);
  if (input.causeId === undefined)
    return write(database, { causeId: null, rootCauseId: id, depth: 0 });
  // One transaction holds the advisory lock through the insert. A caller that
  // already passed its own transaction handle gets that same handle back
  // (`PostgresDatabase.transaction` does not nest), so the lock lives exactly
  // as long as the write it protects.
  return database.transaction(async (tx) =>
    write(tx, await resolveCascade(tx, input.causeId as string, mentions.length)),
  );
}

/**
 * Restate an existing line in place (a retried failure, a settled failure, a
 * grant card that gained another ask). The row keeps its id, so a push claimed
 * on it never fires twice.
 */
export async function restateSystemLine(
  database: SqlDatabase,
  messageId: string,
  phrase: SystemPhrase,
  card?: Record<string, unknown>,
): Promise<{ text: string; event: SystemEvent; updated: boolean }> {
  const { text, event } = composeSystemLine(phrase);
  const result = await database.query(
    `UPDATE messages SET text=$2,system_event=$3::jsonb,card=COALESCE($4::jsonb,card) WHERE id=$1`,
    [messageId, text, JSON.stringify(event), card ? JSON.stringify(card) : null],
  );
  return { text, event, updated: Boolean(result.rowCount) };
}

/** The subject shape for a Room identity row. */
export function identitySubject(row: {
  id: string;
  kind: 'human' | 'agent';
  name: string;
}): SystemSubject {
  return { kind: row.kind === 'agent' ? 'agent' : 'person', id: row.id, name: row.name };
}

export const GITHUB_SUBJECT: SystemSubject = { kind: 'github', name: 'GitHub' };
