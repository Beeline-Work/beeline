/**
 * `@agent /login`: the server's relay between the agent owner's phone and the
 * agent's helper. Nothing secret is stored. Every step travels as one
 * PostgreSQL NOTIFY so it reaches whichever server instance holds the
 * helper's socket (`start`/`code`) or a waiting phone request
 * (`link`/`result`). A pasted code or key rides only the `code` step and is
 * never written to a table, a card, a log line, or an error message.
 *
 * The card (`agent-sign-in`, written by `agent-command.ts`) is the durable
 * state: the machine's answer to `start` (a link, a device code, or a key
 * field) and every result settle it, including results that arrive later on
 * their own (a device code approved on the provider's page).
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_SIGN_IN_INPUT_MAX_LENGTH,
  isAgentSignInKeyProvider,
  type AgentSignInLink,
  type CompleteAgentSignInResult,
  type ReportAgentSignInInput,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { LiveEvent, LiveHub } from './live.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

export const AGENT_SIGN_IN_TABLE = 'agent_sign_in';
/** The helper answers `start` with what it read from the harness's own login. */
export const AGENT_SIGN_IN_LINK_WAIT_MS = 30_000;
/** A pasted code or key: the helper's exchange has its own 30 s deadline; this covers it. */
export const AGENT_SIGN_IN_RESULT_WAIT_MS = 45_000;

export const AGENT_SIGN_IN_OFFLINE_MESSAGE =
  "The agent's machine is offline. Start its helper with `beeline start`, then try again.";
export const AGENT_SIGN_IN_NO_ANSWER_MESSAGE =
  "The agent's machine did not answer. Check its helper is running and up to date, then try again.";

export type AgentSignInEvent = Extract<LiveEvent, { type: 'agent-sign-in' }>;

type Step = AgentSignInEvent['step'];
type AgentSignInStep = AgentSignInEvent extends infer Event
  ? Event extends AgentSignInEvent
    ? Omit<Event, 'type' | 'roomId'>
    : never
  : never;

const ATTEMPT_ID = /^[0-9a-f-]{36}$/;
const CARD_ID = /^[0-9a-f]{64}$/;
const USER_CODE = /^[A-Z0-9-]{4,16}$/;
const MAX_REPORT_TEXT = 2_048;
const CARD_TYPE = 'agent-sign-in';

function httpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://') && value.length <= MAX_REPORT_TEXT;
}

/** The machine's answer to `start`, validated; anything else is dropped. */
export function readAgentSignInLink(value: Record<string, unknown>): AgentSignInLink | undefined {
  switch (value.kind) {
    case 'paste-code':
    case 'approve-wait':
      return httpsUrl(value.authorizeUrl)
        ? { kind: value.kind, authorizeUrl: value.authorizeUrl }
        : undefined;
    case 'device-code':
      return httpsUrl(value.authorizeUrl) &&
        typeof value.userCode === 'string' &&
        USER_CODE.test(value.userCode) &&
        typeof value.expiresAt === 'number' &&
        Number.isFinite(value.expiresAt)
        ? {
            kind: 'device-code',
            authorizeUrl: value.authorizeUrl,
            userCode: value.userCode,
            expiresAt: value.expiresAt,
          }
        : undefined;
    case 'api-key':
      return isAgentSignInKeyProvider(value.provider)
        ? { kind: 'api-key', provider: value.provider }
        : undefined;
    default:
      return undefined;
  }
}

/** Decode one NOTIFY payload for this table; anything malformed is dropped. */
export function decodeAgentSignInNotification(raw: string): AgentSignInEvent | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (parsed.table !== AGENT_SIGN_IN_TABLE) return undefined;
  const { agentId, attemptId, step } = parsed;
  if (typeof agentId !== 'string' || !agentId) return undefined;
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) return undefined;
  const base = { type: 'agent-sign-in' as const, roomId: '' as const, agentId, attemptId };
  switch (step as Step) {
    case 'start':
      return typeof parsed.cardId === 'string' && CARD_ID.test(parsed.cardId)
        ? { ...base, step: 'start', cardId: parsed.cardId }
        : undefined;
    case 'code':
      return typeof parsed.code === 'string' && parsed.code
        ? { ...base, step: 'code', code: parsed.code }
        : undefined;
    case 'link': {
      const link =
        parsed.link && typeof parsed.link === 'object'
          ? readAgentSignInLink(parsed.link as Record<string, unknown>)
          : undefined;
      return link ? { ...base, step: 'link', link } : undefined;
    }
    case 'result':
      if (parsed.outcome === 'signed-in') return { ...base, step: 'result', outcome: 'signed-in' };
      return parsed.outcome === 'failed' && typeof parsed.error === 'string'
        ? { ...base, step: 'result', outcome: 'failed', error: parsed.error }
        : undefined;
    default:
      return undefined;
  }
}

async function notify(
  database: Pick<SqlDatabase, 'query'>,
  event: AgentSignInStep,
): Promise<void> {
  await database.query(`SELECT pg_notify($1, $2)`, [
    POSTGRES_LIVE_CHANNEL,
    JSON.stringify({ table: AGENT_SIGN_IN_TABLE, operation: 'UPDATE', roomId: '', ...event }),
  ]);
}

/**
 * Resolve with the first matching event for this attempt, or reject with the
 * no-answer message once `timeoutMs` passes. Subscribe before notifying so a
 * fast helper cannot answer into the void.
 */
function awaitAnswer(
  live: LiveHub,
  agentId: string,
  attemptId: string,
  steps: readonly Step[],
  timeoutMs: number,
): { readonly answer: Promise<AgentSignInEvent>; readonly cancel: () => void } {
  let release = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = new Promise<AgentSignInEvent>((resolve, reject) => {
    release = live.subscribeAll((event) => {
      if (
        event.type === 'agent-sign-in' &&
        event.agentId === agentId &&
        event.attemptId === attemptId &&
        steps.includes(event.step)
      ) {
        resolve(event);
      }
    });
    timer = setTimeout(() => reject(new Error(AGENT_SIGN_IN_NO_ANSWER_MESSAGE)), timeoutMs);
    timer.unref?.();
  });
  const cancel = () => {
    release();
    if (timer) clearTimeout(timer);
  };
  void answer.then(cancel, cancel);
  return { answer, cancel };
}

function failedAnswer(event: AgentSignInEvent): Error | undefined {
  return event.step === 'result' && event.outcome === 'failed' ? new Error(event.error) : undefined;
}

/** The agent's helper holds a live connection right now (any server instance). */
export async function agentHelperOnline(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
): Promise<boolean> {
  const result = await database.query(
    `SELECT 1 FROM agent_connections WHERE agent_id=$1 AND released_at IS NULL`,
    [agentId],
  );
  return Boolean(result.rowCount);
}

/** Ask the agent's machine to start its harness's login for card `cardId`. */
export async function startAgentSignIn(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub,
  agentId: string,
  attempt: { readonly attemptId: string; readonly cardId: string },
  options: { readonly timeoutMs?: number } = {},
): Promise<AgentSignInLink> {
  if (!(await agentHelperOnline(database, agentId))) throw new Error(AGENT_SIGN_IN_OFFLINE_MESSAGE);
  const waiter = awaitAnswer(
    live,
    agentId,
    attempt.attemptId,
    ['link', 'result'],
    options.timeoutMs ?? AGENT_SIGN_IN_LINK_WAIT_MS,
  );
  try {
    await notify(database, { agentId, ...attempt, step: 'start' });
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  const event = await waiter.answer;
  const failure = failedAnswer(event);
  if (failure) throw failure;
  if (event.step !== 'link') throw new Error(AGENT_SIGN_IN_NO_ANSWER_MESSAGE);
  return event.link;
}

/** Relay a pasted code or key to the machine and wait for its verdict. */
export async function completeAgentSignIn(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub,
  agentId: string,
  input: { readonly attemptId: unknown; readonly code: unknown },
  options: { readonly timeoutMs?: number } = {},
): Promise<CompleteAgentSignInResult> {
  if (typeof input.attemptId !== 'string' || !ATTEMPT_ID.test(input.attemptId))
    throw new Error('sign-in attempt is invalid');
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!code) throw new Error('the code or key is required');
  if (code.length > AGENT_SIGN_IN_INPUT_MAX_LENGTH) throw new Error('the code or key is invalid');
  if (!(await agentHelperOnline(database, agentId))) throw new Error(AGENT_SIGN_IN_OFFLINE_MESSAGE);
  const attemptId = input.attemptId;
  const waiter = awaitAnswer(
    live,
    agentId,
    attemptId,
    ['result'],
    options.timeoutMs ?? AGENT_SIGN_IN_RESULT_WAIT_MS,
  );
  try {
    await notify(database, { agentId, attemptId, step: 'code', code });
  } catch {
    waiter.cancel();
    // A driver error could quote the statement's parameters; never surface it.
    throw new Error(AGENT_SIGN_IN_NO_ANSWER_MESSAGE);
  }
  const event = await waiter.answer;
  const failure = failedAnswer(event);
  if (failure) throw failure;
  return { signedIn: true };
}

type StoredCard = {
  agentId: string;
  ownerId: string;
  status: string;
  kind?: string;
  sourceMessageId?: string;
  attemptId?: string;
};

async function settleCard(
  database: Pick<SqlDatabase, 'query'>,
  where: { readonly messageId: string; readonly agentId?: string; readonly attemptId?: string },
  patch: Record<string, string | number>,
  clearError: boolean,
): Promise<void> {
  await database.query(
    `UPDATE messages SET card=(CASE WHEN $3 THEN card-'errorMessage' ELSE card END)||$2::jsonb
     WHERE id=$1 AND card_type='${CARD_TYPE}' AND card->>'status'<>'signed-in'
       AND ($4::text IS NULL OR card->>'agentId'=$4)
       AND ($5::text IS NULL OR card->>'attemptId'=$5)`,
    [
      where.messageId,
      JSON.stringify(patch),
      clearError,
      where.agentId ?? null,
      where.attemptId ?? null,
    ],
  );
}

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * The helper's report for one attempt: relayed to any waiting phone request,
 * and, for a result, settled on the card it names (only that agent's own
 * card for that attempt).
 */
export async function reportAgentSignIn(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  input: ReportAgentSignInInput,
): Promise<void> {
  if (typeof input.attemptId !== 'string' || !ATTEMPT_ID.test(input.attemptId))
    throw new Error('sign-in attempt is invalid');
  const attemptId = input.attemptId;
  if ('kind' in input) {
    const link = readAgentSignInLink(input as unknown as Record<string, unknown>);
    if (!link) throw new Error('sign-in link is invalid');
    await notify(database, { agentId, attemptId, step: 'link', link });
    return;
  }
  const cardId =
    typeof input.cardId === 'string' && CARD_ID.test(input.cardId) ? input.cardId : undefined;
  if (input.outcome === 'signed-in') {
    await notify(database, { agentId, attemptId, step: 'result', outcome: 'signed-in' });
    if (cardId)
      await settleCard(database, { messageId: cardId, agentId, attemptId }, { status: 'signed-in' }, true);
    return;
  }
  if (input.outcome === 'failed') {
    const error =
      (typeof input.error === 'string' ? input.error.trim().slice(0, 500) : '') ||
      'Sign-in failed on the agent machine.';
    await notify(database, { agentId, attemptId, step: 'result', outcome: 'failed', error });
    if (cardId)
      await settleCard(
        database,
        { messageId: cardId, agentId, attemptId },
        { status: 'failed', errorMessage: error },
        false,
      );
    return;
  }
  throw new Error('sign-in report is invalid');
}

/**
 * After an `@agent /login` message commits, ask the agent's machine to start
 * its harness's login and put what it answers on the card, or settle the card
 * with why not.
 */
export async function beginAgentSignInCards(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub,
  roomId: string,
  sourceMessageId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const cards = await database.query<{ id: string; card: StoredCard }>(
    `SELECT id,card FROM messages WHERE room_id=$1 AND card_type='${CARD_TYPE}'
       AND card->>'sourceMessageId'=$2 AND card->>'status'='starting'`,
    [roomId, sourceMessageId],
  );
  for (const { id, card } of cards.rows) {
    // The attempt is on the card before the machine hears of it, so a result
    // the machine reports on its own always finds the card it settles.
    const attemptId = randomUUID();
    await settleCard(database, { messageId: id }, { attemptId }, false);
    try {
      const link = await startAgentSignIn(database, live, card.agentId, { attemptId, cardId: id }, options);
      await settleCard(database, { messageId: id, attemptId }, { status: 'pending', ...link }, true);
    } catch (error) {
      await settleCard(
        database,
        { messageId: id, attemptId },
        { status: 'failed', errorMessage: failureText(error) },
        false,
      );
    }
  }
}

/**
 * The owner pastes a code (paste-back sign-in) or a key (API-key sign-in)
 * into a sign-in card. Only the agent's current owner, still in the Room, may
 * complete it; the value is relayed and never stored. A rejected value leaves
 * the card open for another paste. Device-code and approve-and-wait cards
 * settle on their own from the machine's report.
 */
export async function completeAgentSignInCard(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub,
  input: { readonly roomId: unknown; readonly messageId: unknown; readonly code: unknown },
  viewerId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<CompleteAgentSignInResult> {
  if (typeof input.roomId !== 'string' || typeof input.messageId !== 'string')
    throw new Error('sign-in card is invalid');
  const row = (
    await database.query<{ card: StoredCard; owner_id: string; member: boolean }>(
      `SELECT message.card,agent.owner_id,
         EXISTS(SELECT 1 FROM memberships m WHERE m.room_id=message.room_id
           AND m.identity_id=$3 AND m.removed_at IS NULL) member
       FROM messages message
       JOIN agents agent ON agent.agent_id=message.card->>'agentId'
       WHERE message.id=$1 AND message.room_id::text=$2 AND message.card_type='${CARD_TYPE}'`,
      [input.messageId, input.roomId, viewerId],
    )
  ).rows[0];
  if (!row || !row.member) throw new Error('sign-in card not found');
  if (row.owner_id !== viewerId) throw new Error("Only the agent's owner can change this");
  const { card } = row;
  if (card.status === 'signed-in') return { signedIn: true };
  if (card.kind !== 'paste-code' && card.kind !== 'api-key')
    throw new Error('this sign-in finishes on the provider’s page, not here');
  if (!card.attemptId || (card.status !== 'pending' && card.status !== 'failed'))
    throw new Error('this sign-in is not waiting for a code');
  const where = { messageId: input.messageId, attemptId: card.attemptId };
  await settleCard(database, where, { status: 'signing-in' }, true);
  try {
    const result = await completeAgentSignIn(
      database,
      live,
      card.agentId,
      { attemptId: card.attemptId, code: input.code },
      options,
    );
    await settleCard(database, where, { status: 'signed-in' }, true);
    return result;
  } catch (error) {
    await settleCard(database, where, { status: 'failed', errorMessage: failureText(error) }, false);
    throw error;
  }
}
