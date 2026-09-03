import { randomBytes } from 'node:crypto';
import {
  formatSystemLine,
  type SystemEvent,
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
  readonly object?: string | SystemObject;
  readonly consequence?: string;
  /** Identities to mention: the only thing that makes a line push or wake a daemon. */
  readonly mentions?: readonly string[];
  readonly presentation?: 'system' | 'card';
  readonly cardType?: string;
  readonly card?: Record<string, unknown>;
  readonly requestId?: string;
  readonly durableFact?: 'failure' | 'merge' | 'action';
}

export interface SystemLineResult {
  readonly id: string;
  readonly text: string;
  readonly event: SystemEvent;
  /** False when a deterministic id already existed. */
  readonly inserted: boolean;
}

export type SystemPhrase = Pick<SystemLineInput, 'subject' | 'verb' | 'object' | 'consequence'>;

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
  };
  return { text: formatSystemLine(event), event };
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
  const result = await database.query(
    `INSERT INTO messages(
       id,room_id,author_id,text,presentation,mention_ids,request_id,durable_fact,
       card_type,card,system_event
     ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb)
     ON CONFLICT(id) DO NOTHING`,
    [
      id,
      input.roomId,
      authorId,
      text,
      input.presentation ?? 'system',
      JSON.stringify([...new Set(input.mentions ?? [])]),
      input.requestId ?? null,
      input.durableFact ?? null,
      input.cardType ?? null,
      input.card ? JSON.stringify(input.card) : null,
      JSON.stringify(event),
    ],
  );
  return { id, text, event, inserted: Boolean(result.rowCount) };
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
