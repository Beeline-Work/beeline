import { restoreRoomMemberships, restoreRoomMembershipsSql } from './membership-join.js';
import { roomEventSubscriptions } from './agent-subscriptions.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { CornerAccessDatabase } from './corner-access-database.js';
import { approvalAsk } from './tray-approval-ask.js';
import { createAgentCommand, type CommandRow, routeSystemCommand } from './agent-command.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  formatSystemLine,
  isSubscribableEventKind,
  type SystemEvent,
  type SystemEventKind,
  type SystemObject,
  type SystemSubject,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import {
  SYSTEM_IDENTITY_HANDLE,
  SYSTEM_IDENTITY_ID,
  SYSTEM_IDENTITY_NAME,
} from '@beeline/api-contract/system-identity';

/**
 * The one producer of every system notification in a Room or Workspace.
 *
 * Every membership note, yolo change, grant line, failed turn, GitHub fact,
 * corner marker, scheduled prompt and card header is composed here from the
 * System-message catalog, in one
 * grammar (`@beeline/api-contract` `system-events.ts`): `<subject> <verb>
 * [ <object>][ · <consequence>]`. The stored text is what an old phone shows
 * verbatim; the structured `messages.system_event` beside it is what a current
 * phone renders (names as tappable mentions, the object linked by its URL,
 * same-verb runs folded). The daemon never phrases a line: it posts events and
 * the server calls this. `system-line.contract.test.ts` fails the build on any
 * `presentation='system'` insert or any text restatement outside this file.
 *
 * A line is the default container. A card (`presentation: 'card'`) is only for
 * something a tap must settle — a grant request, a connector offer, a permission
 * ask, a choice question or poll, the merge summary with its pull-request
 * link — and keeps its own component on the phone; its header sentence still
 * comes from here.
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
   * subscriber fill below turns it into wakes, in one place. A line with no
   * kind is one nothing subscribes to.
   */
  readonly kind?: SystemEventKind;
  /** The schedule a `schedule-ran` line fired, so its run may inherit its sessions. */
  readonly scheduleId?: string;
  readonly payload?: unknown;
  readonly subscriptionPrompt?: string;
  readonly subscriptionWorkflowSlug?: string;
  readonly object?: string | SystemObject;
  readonly consequence?: string;
  /** A second named actor in the consequence slot (currently the inviter on a join). */
  readonly attribution?: {
    readonly verb: string;
    readonly actor: SystemSubject;
  };
  /**
   * Agents this line wakes, named outright because a system line addresses by
   * FACT rather than by text: nothing in `@scheduler ran a schedule for Ada`
   * spells a handle, so there is no tag for `message-mentions.ts` to read. This
   * is a routing list only — it starts turns, and never stands in for a tag.
   */
  readonly wakes?: readonly string[];
  /** Agent-only browser observations use activity and never paint in the transcript. */
  readonly presentation?: 'system' | 'card' | 'activity';
  readonly cardType?: string;
  readonly card?: Record<string, unknown>;
  readonly requestId?: string;
  readonly commandId?: string;
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
  /**
   * The message this line is written BECAUSE OF, for a line with no kind.
   *
   * Ordering only — it is never stored as a cascade, so an unkinded line keeps
   * waking nobody. The write stamps `created_at` strictly past this message's
   * second, so a consequence can never sort above its cause on a surface that
   * orders by whole seconds (`RoomViewMessage.createdAt` is floored): a
   * second-resolution tie otherwise breaks on the random row id, which is how
   * an access notice landed above the message that provoked it.
   */
  readonly afterMessageId?: string;
}

export function directMessageRoomId(
  workspaceId: string,
  participants: readonly [string, string],
): string {
  const bytes = createHash('sha256')
    .update(`buzz-dm:v1:${workspaceId}:${participants.join(':')}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function ensureSystemIdentity(database: SqlDatabase): Promise<void> {
  // Existing canonical authors need no write lock. An unconditional conflict
  // UPDATE serializes unrelated corner transactions on this shared row.
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,hidden_from_roster,avatar)
     SELECT $1,'human',$2,$3,true,$4
     WHERE NOT EXISTS (
       SELECT 1 FROM identities WHERE id=$1
         AND (name,handle,hidden_from_roster,avatar)
           IS NOT DISTINCT FROM ($2::text,$3::text,true,$4::text)
     ) ON CONFLICT(id) DO UPDATE
     SET name=EXCLUDED.name,handle=EXCLUDED.handle,hidden_from_roster=true,
         avatar=EXCLUDED.avatar,updated_at=now()`,
    [
      SYSTEM_IDENTITY_ID,
      SYSTEM_IDENTITY_NAME,
      SYSTEM_IDENTITY_HANDLE,
      '/v1/connectors/logo/system.svg',
    ],
  );
}

export async function ensureSystemDirectMessageRoom(
  database: SqlDatabase,
  workspaceId: string,
  personId: string,
): Promise<string> {
  return (await ensureSystemDirectMessageRoomResult(database, workspaceId, personId)).id;
}

export async function ensureSystemDirectMessageRoomResult(
  database: SqlDatabase,
  workspaceId: string,
  personId: string,
): Promise<{ id: string; created: boolean }> {
    database = new CornerAccessDatabase(database);
  await ensureSystemIdentity(database);
  const participants = [SYSTEM_IDENTITY_ID, personId].sort() as [string, string];
  const roomId = directMessageRoomId(workspaceId, participants);
  const inserted = await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
     VALUES ($1,$2,$3,'Direct message','invite-only',$4::jsonb)
     ON CONFLICT(id) DO NOTHING RETURNING id`,
    [roomId, workspaceId, SYSTEM_IDENTITY_ID, JSON.stringify(participants)],
  );
  if (!inserted.rowCount) {
    await database.query(`UPDATE rooms SET visibility='invite-only' WHERE id=$1`, [roomId]);
  }
  await restoreRoomMemberships(database,workspaceId,roomId,participants);
  return { id: roomId, created: Boolean(inserted.rowCount) };
}

/**
 * An emitted event must cite an available cause. The emitting tool surfaces
 * this refusal without posting a fact that cannot be traced.
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
  'subject' | 'verb' | 'object' | 'consequence' | 'attribution' | 'kind' | 'scheduleId' | 'payload' | 'subscriptionPrompt' | 'subscriptionWorkflowSlug'
>;

const CLEAN = /[\s ]+/g;

function clause(value: string): string {
  return value.replace(CLEAN, systemMessage("system-line.space")).trim();
}

/** The text and the structured event for one phrase; pure, so tests can pin both. */
export function composeSystemLine(phrase: SystemPhrase): { text: string; event: SystemEvent } {
  const object: SystemObject | undefined =
    phrase.object === undefined
      ? undefined
      : typeof phrase.object === 'string'
        ? { text: clause(phrase.object) }
        : { ...phrase.object, text: clause(phrase.object.text) };
  const attribution = phrase.attribution
    ? [clause(phrase.attribution.verb), clause(phrase.attribution.actor.name)]
        .filter(Boolean)
        .join(systemMessage("system-line.space"))
    : undefined;
  const consequence = phrase.consequence ? clause(phrase.consequence) : attribution || undefined;
  const event: SystemEvent = {
    subject: { ...phrase.subject, name: clause(phrase.subject.name) },
    verb: clause(phrase.verb),
    ...(object && object.text ? { object } : {}),
    ...(consequence ? { consequence } : {}),
    ...(phrase.kind ? { kind: phrase.kind } : {}),
    ...(phrase.scheduleId ? { scheduleId: phrase.scheduleId } : {}),
    ...(phrase.kind === 'subscription-fired' || phrase.kind === 'check-failed' ||
      phrase.kind === 'computer-session-activity' ? {
      payload: phrase.payload,
      ...(phrase.subscriptionPrompt ? { subscriptionPrompt: phrase.subscriptionPrompt } : {}),
      ...(phrase.subscriptionWorkflowSlug ? { subscriptionWorkflowSlug: phrase.subscriptionWorkflowSlug } : {}),
    } : {}),
  };
  // The kind never reaches the text: `formatSystemLine` reads subject, verb,
  // object and consequence, so a line's wording is exactly what it was before
  // it carried a kind.
  return { text: formatSystemLine(event), event };
}

type IdentityLabelRow = {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle: string | null;
};

function agentHandle(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, systemMessage("system-line.handle-word-separator"))
      .replace(/[^a-z0-9_]/g, '') || systemMessage("system-line.agent")
  );
}

/** The canonical mention for an identity addressed by a system line. */
export function systemIdentityMention(row: IdentityLabelRow): string {
  if (row.kind === 'human') return row.handle ? systemMessage("system-line.identity-mention", row.handle) : '';
  return systemMessage("system-line.identity-mention", row.handle ?? agentHandle(row.name));
}

async function canonicalPhrase(
  database: SqlDatabase,
  phrase: SystemPhrase,
  plainSubjectId?: string,
): Promise<SystemPhrase> {
  const ids = [
    phrase.subject.id,
    typeof phrase.object === 'string' ? undefined : phrase.object?.id,
    phrase.attribution?.actor.id,
  ].filter((id): id is string => Boolean(id));
  const rows = ids.length
    ? await database.query<IdentityLabelRow>(
        `SELECT id,kind,name,handle FROM identities WHERE id=ANY($1::text[])`,
        [[...new Set(ids)]],
      )
    : { rows: [] };
  const identities = new Map(rows.rows.map((row) => [row.id, row]));
  return labeledPhrase(phrase, identities, plainSubjectId);
}

function labeledPhrase(phrase: SystemPhrase, identities: ReadonlyMap<string, IdentityLabelRow>, plainSubjectId?: string): SystemPhrase {
  const subjectRow = phrase.subject.id ? identities.get(phrase.subject.id) : undefined;
  const object = typeof phrase.object === 'string' ? undefined : phrase.object;
  const objectRow = object?.id ? identities.get(object.id) : undefined;
  const attributionRow = phrase.attribution?.actor.id
    ? identities.get(phrase.attribution.actor.id)
    : undefined;
  const fallbackSubjectName =
    phrase.subject.kind === 'agent'
      ? systemMessage("system-line.identity-mention", agentHandle(phrase.subject.name))
      : phrase.subject.kind === 'github'
        ? phrase.kind === 'subscription-fired' && phrase.subject.name === 'GitHub'
          ? systemMessage("system-line.github")
          : systemMessage("system-line.identity-mention", clause(phrase.subject.name).replace(/^@/, ''))
        : phrase.subject.name;
  return {
    ...phrase,
    subject: {
      ...phrase.subject,
      name:
        plainSubjectId && phrase.subject.id === plainSubjectId
          ? subjectRow?.name ?? phrase.subject.name
          : subjectRow
            ? systemIdentityMention(subjectRow)
            : fallbackSubjectName,
    },
    ...(objectRow && object && clause(object.text) === clause(objectRow.name)
      ? { object: { ...object, text: systemIdentityMention(objectRow) } }
      : {}),
    ...(phrase.attribution && attributionRow
      ? {
          attribution: {
            ...phrase.attribution,
            actor: {
              ...phrase.attribution.actor,
              name: systemIdentityMention(attributionRow),
            },
          },
        }
      : {}),
  };
}


type Cascade = { causeId: string | null; rootCauseId: string; depth: number };

/**
 * The instant a caused line must not precede: its cause's second, exhausted.
 *
 * `RoomViewMessage.createdAt` reaches the phone floored to whole seconds, and
 * every transcript sort tie-breaks on the row id — a random 64-hex string. A
 * line written microseconds after the message that provoked it shares that
 * message's second, so the tie could order the consequence ABOVE its cause.
 * The write therefore stamps `created_at` at least one second past the cause's
 * second, and only then: when `now()` has already moved on, `GREATEST` keeps
 * the natural time and the row is never future-dated by more than that one
 * second. A miss or a failed lookup writes the line unpinned — an ordering
 * courtesy must never fail a write (the caller's transaction aside).
 */
async function orderingFloor(
  database: SqlDatabase,
  roomId: string,
  causeId: string | undefined,
): Promise<Date | null> {
  if (!causeId) return null;
  try {
    const cause = await database.query<{ created_at: Date }>(
      `SELECT created_at FROM messages WHERE id=$1 AND room_id=$2`,
      [causeId, roomId],
    );
    const created = cause.rows[0]?.created_at;
    return created ? new Date(created.getTime() + 1_000) : null;
  } catch (error) {
    console.error('[system-line] ordering lookup failed', roomId, causeId, error);
    return null;
  }
}

/** Derive causal trace metadata from the committed cause, never caller-supplied bounds. */
async function resolveCascade(
  database: SqlDatabase,
  causeId: string,
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
  return { causeId, rootCauseId, depth };
}

/** Insert one system line (or card) in a Room. */
export async function systemLine(
  database: SqlDatabase,
  input: SystemLineInput,
): Promise<SystemLineResult> {
    database = new CornerAccessDatabase(database);
  const authorId = input.authorId ?? input.subject.id;
  if (!authorId) throw new Error('system line needs an author identity');
  // Workflow cards name their own author without a self-address.
  const { text, event } = composeSystemLine(
    await canonicalPhrase(
      database,
      input,
      input.cardType === 'workflow-handoff' ? authorId : undefined,
    ),
  );
  const id = input.id ?? randomBytes(32).toString('hex');
  let subscriptions: Awaited<ReturnType<typeof roomEventSubscriptions>> = [];
  let wakes = [...new Set(input.wakes ?? [])].filter(agentId => input.kind !== 'corner-opened' || agentId !== input.subject.id);
  // Only an event carries a cascade. A line with no kind is one nothing reacts
  // to, so it has no causal trace.
  const write = async (
    db: SqlDatabase,
    cascade: Cascade | undefined,
    notBefore: Date | null,
    watches: { watcher_room_id: string; agent_id: string; incoming_command: CommandRow | null }[],
  ) => {
    const result = await db.query(
      `INSERT INTO messages(
         id,room_id,author_id,text,presentation,request_id,durable_fact,
         card_type,card,system_event,event_cause_id,event_root_cause_id,event_depth,created_at
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,
         GREATEST(now(), COALESCE($14::timestamptz, now()))
       )
       ON CONFLICT DO NOTHING`,
      [
        id,
        input.roomId,
        authorId,
        text,
        input.presentation ?? 'system',
        input.requestId ?? null,
        input.durableFact ?? null,
        input.cardType ?? null,
        input.card ? JSON.stringify({ ...input.card, ask: approvalAsk(input.cardType, input.card) }) : null,
        JSON.stringify(event),
        cascade?.causeId ?? null,
        cascade?.rootCauseId ?? null,
        cascade?.depth ?? null,
        notBefore,
      ],
    );
    if (result.rowCount) {
      // Preserve message-before-subscription lock order. One capture chooses each
      // subscription's mode, so a prompt edit cannot dispatch twice on two cuts.
      if (input.kind && isSubscribableEventKind(input.kind)) {
        await db.query('SAVEPOINT room_event_recipients');
        try {
          subscriptions = await roomEventSubscriptions(db, input.roomId, input.kind, true);
        } catch (error) {
          // Preserve the fact and explicit targets even after a failed SQL lookup.
          await db.query('ROLLBACK TO SAVEPOINT room_event_recipients');
          console.error('[system-line] subscriber lookup failed', input.roomId, input.kind, error);
        }
        await db.query('RELEASE SAVEPOINT room_event_recipients');
        wakes = [...new Set([...wakes, ...subscriptions
          .filter(row => row.prompt === null && input.kind !== 'corner-opened').map(row => row.agent_id)])];
      }

      const watched = watches.length ? (await db.query<{ name: string; merge_sha: string | null }>(`SELECT room.name,fact.lifecycle->'pr'->>'mergeCommitSha' merge_sha FROM rooms room LEFT JOIN corner_github_cache fact ON fact.corner_id=room.id WHERE room.id=$1`, [input.card?.cornerId ?? input.roomId])).rows[0] : undefined;
      for (const watch of watches)
        await createAgentCommand(db, {
          roomId: watch.watcher_room_id,
          agentId: watch.agent_id,
          sourceMessageId: id,
          privatePayload: { text: `Watched corner ${watched?.name ?? input.subject.name} (${input.card?.cornerId ?? input.roomId}): ${input.kind === 'corner-opened' ? 'opened' : input.kind}${input.kind === 'merged' && watched?.merge_sha ? ` · merge commit ${watched?.merge_sha}` : ''}\n${text}`, authorId: SYSTEM_IDENTITY_ID, fromRoomId: String(input.card?.cornerId ?? input.roomId), kind: 'lifecycle' },
          reason: 'watched_corner',
          parent: watch.incoming_command ?? undefined, retainDepth: true,
          action: 'input',
        });
      await routeSystemCommand(db, {
        roomId: input.roomId,
        sourceMessageId: id,
        kind: input.kind,
        targets: wakes,
        assignmentTargets: input.kind === 'workflow-handoff' ? input.wakes : undefined,
        requestId: input.requestId,
        causeId: input.causeId,
        commandId: input.commandId,
        followup: input.kind === 'check-failed' &&
          Boolean((input.payload as { followup?: unknown } | undefined)?.followup),
      });
      if (input.kind && isSubscribableEventKind(input.kind) && subscriptions.some(row => row.prompt !== null)) {
        for (const subscription of subscriptions.filter(row => row.prompt !== null)) {
          if (input.kind === 'corner-opened' && subscription.agent_id === input.subject.id) continue;
          const firedId = createHash('sha256').update(`room-subscription:${id}:${subscription.id}`).digest('hex');
          const fired = await systemLine(db, {
            id: firedId, roomId: input.roomId, authorId: SYSTEM_IDENTITY_ID,
            subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: systemMessage("system-line.beeline") },
            verb: systemMessage("system-line.received"), object: systemMessage("system-line.a-room-event"), consequence: input.kind,
            kind: 'subscription-fired', causeId: id, wakes: [subscription.agent_id],
            payload: { source: 'room', event: input.kind, text },
            subscriptionPrompt: subscription.prompt!,
            subscriptionWorkflowSlug: subscription.workflow_slug ?? undefined,
          });
          if (fired.inserted) await db.query(`UPDATE agent_subscriptions
            SET last_fired_at=now(),fired_count=fired_count+1 WHERE id=$1`, [subscription.id]);
        }
      }
    }
    return { id, text, event, inserted: Boolean(result.rowCount) };
  };
  return database.transaction(async (tx) => {
    const watches =
      input.kind === 'merged'
        ? (
            await tx.query<{ watcher_room_id: string; agent_id: string; incoming_command: CommandRow | null }>(
              `SELECT w.watcher_room_id,w.agent_id,to_jsonb(incoming) incoming_command FROM corner_watches w
           LEFT JOIN agent_commands incoming ON incoming.id=w.incoming_command_id
           JOIN rooms corner ON corner.id=w.corner_id AND corner.parent_id IS NOT NULL
           JOIN rooms watcher ON watcher.id=w.watcher_room_id AND watcher.archived_at IS NULL
           JOIN memberships m ON m.room_id=w.watcher_room_id AND m.identity_id=w.agent_id
             AND m.removed_at IS NULL
           WHERE w.corner_id=$1 AND w.kinds @> $2::jsonb
             AND ($3::text IS NULL OR w.agent_id<>$3)
             AND EXISTS(SELECT 1 FROM memberships target WHERE target.room_id IN (corner.id,corner.parent_id)
               AND target.identity_id=w.agent_id AND target.removed_at IS NULL)
           FOR SHARE OF w,m,watcher`,
              [input.roomId, JSON.stringify(['merged']), null],
            )
          ).rows
        : [];
    const cascade = !input.kind
      ? undefined
      : input.causeId === undefined
        ? { causeId: null, rootCauseId: id, depth: 0 }
        : await resolveCascade(tx, input.causeId);
    const notBefore = await orderingFloor(
      tx,
      input.roomId,
      input.kind ? input.causeId : input.afterMessageId,
    );
    return write(tx, cascade, notBefore, watches);
  });
}

/** One committed batch of per-offer answers, with the same grammar and resume
 * owner as individual system lines. Per-item decisions have no subscribers. */
export async function connectorOfferDecisionLines(database: SqlDatabase,
  inputs: readonly (SystemLineInput & { kind: 'connector-offer-decided' })[]): Promise<void> {
  if (!inputs.length) return;
  const ids = [...new Set(inputs.flatMap(input => [input.subject.id,
    typeof input.object === 'string' ? undefined : input.object?.id, input.attribution?.actor.id])
    .filter((id): id is string => Boolean(id)))];
  const labels = (await database.query<IdentityLabelRow>(
    'SELECT id,kind,name,handle FROM identities WHERE id=ANY($1::text[])', [ids])).rows;
  const identities = new Map(labels.map(row => [row.id,row]));
  const lines = inputs.map(input => {
    const id = input.id ?? randomBytes(32).toString('hex');
    const composed = composeSystemLine(labeledPhrase(input,identities));
    return { id,roomId:input.roomId,authorId:input.authorId ?? input.subject.id,
      text:composed.text,event:composed.event,card:input.card
        ? {...input.card,ask:approvalAsk(input.cardType,input.card)} : null,cardType:input.cardType ?? null,
      wakes:[...new Set(input.wakes ?? [])],commandId:input.commandId ?? null,requestId:input.requestId ?? null };
  });
  const inserted = (await database.query<{id:string}>(`INSERT INTO messages(id,room_id,author_id,text,presentation,
    request_id,card_type,card,system_event,event_root_cause_id,event_depth)
    SELECT id,"roomId","authorId",text,'system',"requestId","cardType",card,event,id,0
    FROM jsonb_to_recordset($1::jsonb) AS line(id text,"roomId" uuid,"authorId" text,text text,
      "requestId" text,"cardType" text,card jsonb,event jsonb,wakes jsonb)
    ON CONFLICT DO NOTHING RETURNING id`,[JSON.stringify(lines)])).rows;
  const winners = new Set(inserted.map(row => row.id));
  for (const line of lines) {
    if (!winners.has(line.id) || !line.wakes.length) continue;
    await routeSystemCommand(database,{
      roomId:line.roomId,sourceMessageId:line.id,kind:line.event.kind,targets:line.wakes,
      ...(line.commandId ? {commandId:line.commandId} : {}),...(line.requestId ? {requestId:line.requestId} : {}),
    });
  }
}

/**
 * `watch` on an already merged corner queues one private lifecycle wake.
 * An agent that already received this merge gets none, including legacy wakes.
 */
export async function wakeLateCornerWatcher(
  db: SqlDatabase,
  watcherRoomId: string,
  agentId: string,
  cornerId: string,
  incoming?: CommandRow,
): Promise<boolean> {
  const line = (
    await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1 AND system_event->>'kind'='merged'
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [cornerId],
    )
  ).rows[0];
  if (!line) return false;
  const earlier = await db.query(
    `SELECT 1 FROM agent_commands c JOIN messages m ON m.id=c.source_message_id
     WHERE c.agent_id=$1 AND (m.id=$2 OR (m.system_event->>'kind'='merged'
       AND m.card->>'type'='corner-complete' AND m.card->>'cornerId'=$3))
     LIMIT 1`,
    [agentId, line.id, cornerId],
  );
  if (earlier.rowCount) return false;
  return Boolean(
    await createAgentCommand(db, {
      roomId: watcherRoomId,
      agentId,
      sourceMessageId: line.id,
      privatePayload: { text: `Watched address ${cornerId}: merged`, authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId, kind: 'lifecycle' },
      reason: 'watched_corner',
      parent: incoming, retainDepth: true,
      action: 'input',
    }),
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
  const { text, event } = composeSystemLine(await canonicalPhrase(database, phrase));
  const result = await database.query(
    `UPDATE messages SET text=$2,system_event=$3::jsonb,card=COALESCE($4::jsonb,card) WHERE id=$1`,
    [messageId, text, JSON.stringify(event), card ? JSON.stringify(card) : null],
  );
  return { text, event, updated: Boolean(result.rowCount) };
}

/** Restate committed facts as one batch, without query loops under their rows. */
export async function restateSystemLines(database: SqlDatabase, lines: readonly {
  id: string; phrase: SystemPhrase; card?: Record<string, unknown>;
  presentation?: 'system' | 'card' | 'activity'; createdAt?: Date;
}[]): Promise<void> {
  if (!lines.length) return;
  const ids = [...new Set(lines.flatMap(({phrase}) => [phrase.subject.id,
    typeof phrase.object === 'string' ? undefined : phrase.object?.id, phrase.attribution?.actor.id]
    .filter((id): id is string => Boolean(id))))];
  const identities = new Map((ids.length ? (await database.query<IdentityLabelRow>(
    'SELECT id,kind,name,handle FROM identities WHERE id=ANY($1::text[])', [ids])).rows : []).map(row => [row.id,row]));
  const rows = lines.map(line => ({id:line.id,...composeSystemLine(labeledPhrase(line.phrase,identities)),
    card:line.card,presentation:line.presentation,created_at:line.createdAt}));
  await database.query(`UPDATE messages message SET text=line.text,system_event=line.event,
    card=COALESCE(line.card,message.card),presentation=COALESCE(line.presentation,message.presentation),
    created_at=COALESCE(line.created_at,message.created_at)
    FROM jsonb_to_recordset($1::jsonb) line(id text,text text,event jsonb,card jsonb,presentation text,created_at timestamptz)
    WHERE message.id=line.id`, [JSON.stringify(rows)]);
}

/** Replace an actionable card with its one catalog completion line, retaining its id. */
export async function settleSystemCard(
  database: SqlDatabase,
  messageId: string,
  phrase: SystemPhrase & { readonly authorId: string },
): Promise<{ id: string; text: string; event: SystemEvent }> {
  const { text, event } = await restateSystemLine(database, messageId, phrase);
  await database.query(
    `UPDATE messages SET author_id=$2,presentation='system',card_type=NULL,card=NULL WHERE id=$1`,
    [messageId, phrase.authorId],
  );
  return { id: messageId, text, event };
}

/**
 * The line a deleted message becomes, in its own place: `@deleter deleted a
 * message`, with `· sent by @author` when someone else wrote it. Only the
 * structured event is stored on the deleted row; its text stays empty so no
 * reader of message text can mistake the line for the author's words.
 */
export async function deletedMessageEvent(
  database: SqlDatabase,
  deleterId: string,
  authorId: string,
): Promise<SystemEvent> {
  const rows = await database.query<IdentityLabelRow>(
    `SELECT id,kind,name,handle FROM identities WHERE id=ANY($1::text[])`,
    [[...new Set([deleterId, authorId])]],
  );
  const identities = new Map(rows.rows.map((row) => [row.id, row]));
  const deleter = identities.get(deleterId);
  const author = identities.get(authorId);
  if (!deleter || !author) throw new Error('deleted message identities are missing');
  return composeSystemLine(
    await canonicalPhrase(database, {
      subject: identitySubject(deleter),
      verb: systemMessage("system-line.deleted"),
      object: systemMessage("system-line.a-message"),
      ...(authorId === deleterId
        ? {}
        : { attribution: { verb: 'sent by', actor: identitySubject(author) } }),
    }),
  ).event;
}

/** The subject shape for a Room identity row. */
export function identitySubject(row: {
  id: string;
  kind: 'human' | 'agent';
  name: string;
}): SystemSubject {
  return { kind: row.kind === 'agent' ? 'agent' : 'person', id: row.id, name: row.name };
}

export const GITHUB_SUBJECT: SystemSubject = { kind: 'github', name: systemMessage("system-line.github") };

/** Retire historical human-facing browser observations without losing agent context. */
export async function backfillComputerObservations(database: SqlDatabase): Promise<void> {
  // Old viewer lines remain agent context, but never return in phone history.
  await database.query(`UPDATE messages SET presentation='activity',durable_fact=NULL,
      text=replace(text,'A person','Shared browser'),
      system_event=jsonb_set(system_event,'{subject,name}',
        to_jsonb(replace(system_event->'subject'->>'name','A person','Shared browser')))
    WHERE system_event->>'kind'='computer-session-activity'`);
  // Browser activity accepted by an older release must not start a turn.
  // Claimed turns and commands sourced from a person's message stay intact.
  await database.query(`SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(command.id,command.generation_id,'cancelled',NULL,NULL) ended FROM agent_commands command ,messages source WHERE source.id=command.source_message_id
      AND command.state='pending'
      AND command.reason IN ('subscribed_event','computer_activity')
      AND source.system_event->>'kind'='computer-session-activity') terminal`);
}

/** A plain operator notice in the recipient's existing System thread. */
export async function sendSystemDirectMessage(database: SqlDatabase, workspaceId: string, recipientId: string,
  text: string, id: string): Promise<boolean> {
  const member = await database.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2
    AND room_id IS NULL AND removed_at IS NULL`, [workspaceId, recipientId]);
  if (!member.rowCount) throw new Error('System DM recipient has no active Workspace');
  const roomId = await ensureSystemDirectMessageRoom(database, workspaceId, recipientId);
  const inserted = await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO NOTHING`, [id, roomId, SYSTEM_IDENTITY_ID, text]);
  return Boolean(inserted.rowCount);
}

/** Deliver the same plain system phrase to a recipient set in one statement.
 * Room creation, membership restoration and idempotent notice inserts share
 * one transaction; the statement creates no events or command dispatches. */
export async function sendSystemNotices(database: SqlDatabase, workspaceId: string,
  recipients: readonly { identityId: string; messageId: string }[],
  phrase: Pick<SystemPhrase,'subject'|'verb'|'object'|'consequence'|'attribution'>): Promise<void> {
  if (!recipients.length) return;
  await ensureSystemIdentity(database);
  const { text, event } = composeSystemLine(await canonicalPhrase(database,phrase));
  const notices = recipients.map(recipient=>{
    const participants=[SYSTEM_IDENTITY_ID,recipient.identityId].sort() as [string,string];
    return {id:recipient.messageId,room:directMessageRoomId(workspaceId,participants),participants};
  });
  await database.query(`WITH notices AS MATERIALIZED (
    SELECT notice.* FROM jsonb_to_recordset($1::jsonb) AS notice(id text,room uuid,participants jsonb)
  ), threads AS (
    INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
    SELECT room,$2,$3,'Direct message','invite-only',participants FROM notices
    ON CONFLICT(id) DO UPDATE SET visibility='invite-only' RETURNING id
  ), members AS (
    SELECT $2::uuid workspace_id,thread.id room_id,participant identity_id
    FROM notices notice JOIN threads thread ON thread.id=notice.room
      CROSS JOIN LATERAL jsonb_array_elements_text(notice.participants) participant
  ), restored AS (
    ${restoreRoomMembershipsSql('members')}
  ) INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
    SELECT notice.id,thread.id,$3,$4,'system',$5::jsonb FROM notices notice JOIN threads thread ON thread.id=notice.room
    WHERE EXISTS(SELECT 1 FROM restored WHERE room_id=thread.id) ON CONFLICT(id) DO NOTHING`,
  [JSON.stringify(notices),workspaceId,SYSTEM_IDENTITY_ID,text,JSON.stringify(event)]);
}
