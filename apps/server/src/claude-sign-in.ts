/**
 * Sign in to Claude: the server's relay between the agent owner's phone and
 * the agent's helper. Nothing here is stored. Every step travels as one
 * PostgreSQL NOTIFY so it reaches whichever server instance holds the
 * helper's socket (`start`/`code`) or the phone's waiting request
 * (`link`/`result`). The pasted code rides only the `code` step and is never
 * written to a table, a log line, or an error message.
 */
import { randomUUID } from 'node:crypto';
import {
  CLAUDE_SIGN_IN_CODE_MAX_LENGTH,
  type CompleteClaudeSignInResult,
  type ReportClaudeSignInInput,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { LiveEvent, LiveHub } from './live.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

export const CLAUDE_SIGN_IN_TABLE = 'claude_sign_in';
/** The helper answers `start` with a link it builds locally. */
export const CLAUDE_SIGN_IN_LINK_WAIT_MS = 20_000;
/** The helper's token exchange has its own 30 s deadline; this covers it. */
export const CLAUDE_SIGN_IN_RESULT_WAIT_MS = 45_000;

export const CLAUDE_SIGN_IN_OFFLINE_MESSAGE =
  "The agent's machine is offline. Start its helper with `beeline start`, then try again.";
export const CLAUDE_SIGN_IN_NO_ANSWER_MESSAGE =
  "The agent's machine did not answer. Check its helper is running and up to date, then try again.";

export type ClaudeSignInEvent = Extract<LiveEvent, { type: 'claude-sign-in' }>;
type StartClaudeSignInResult = { readonly attemptId: string; readonly authorizeUrl: string };

type Step = ClaudeSignInEvent['step'];
type ClaudeSignInStep = ClaudeSignInEvent extends infer Event
  ? Event extends ClaudeSignInEvent
    ? Omit<Event, 'type' | 'roomId'>
    : never
  : never;

const ATTEMPT_ID = /^[0-9a-f-]{36}$/;
const MAX_REPORT_TEXT = 2_048;

/** Decode one NOTIFY payload for this table; anything malformed is dropped. */
export function decodeClaudeSignInNotification(raw: string): ClaudeSignInEvent | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (parsed.table !== CLAUDE_SIGN_IN_TABLE) return undefined;
  const { agentId, attemptId, step } = parsed;
  if (typeof agentId !== 'string' || !agentId) return undefined;
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) return undefined;
  const base = { type: 'claude-sign-in' as const, roomId: '' as const, agentId, attemptId };
  switch (step as Step) {
    case 'start':
      return { ...base, step: 'start' };
    case 'code':
      return typeof parsed.code === 'string' && parsed.code
        ? { ...base, step: 'code', code: parsed.code }
        : undefined;
    case 'link':
      return typeof parsed.authorizeUrl === 'string'
        ? { ...base, step: 'link', authorizeUrl: parsed.authorizeUrl }
        : undefined;
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
  event: ClaudeSignInStep,
): Promise<void> {
  await database.query(`SELECT pg_notify($1, $2)`, [
    POSTGRES_LIVE_CHANNEL,
    JSON.stringify({ table: CLAUDE_SIGN_IN_TABLE, operation: 'UPDATE', roomId: '', ...event }),
  ]);
}

/**
 * Resolve with the first `link`/`result` event for this attempt, or reject
 * with the no-answer message once `timeoutMs` passes. Subscribe before
 * notifying so a fast helper cannot answer into the void.
 */
function awaitAnswer(
  live: LiveHub,
  agentId: string,
  attemptId: string,
  steps: readonly Step[],
  timeoutMs: number,
): { readonly answer: Promise<ClaudeSignInEvent>; readonly cancel: () => void } {
  let release = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = new Promise<ClaudeSignInEvent>((resolve, reject) => {
    release = live.subscribeAll((event) => {
      if (
        event.type === 'claude-sign-in' &&
        event.agentId === agentId &&
        event.attemptId === attemptId &&
        steps.includes(event.step)
      ) {
        resolve(event);
      }
    });
    timer = setTimeout(() => reject(new Error(CLAUDE_SIGN_IN_NO_ANSWER_MESSAGE)), timeoutMs);
    timer.unref?.();
  });
  const cancel = () => {
    release();
    if (timer) clearTimeout(timer);
  };
  void answer.then(cancel, cancel);
  return { answer, cancel };
}

function failedAnswer(event: ClaudeSignInEvent): Error | undefined {
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

export async function startClaudeSignIn(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub,
  agentId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<StartClaudeSignInResult> {
  if (!(await agentHelperOnline(database, agentId))) throw new Error(CLAUDE_SIGN_IN_OFFLINE_MESSAGE);
  const attemptId = randomUUID();
  const waiter = awaitAnswer(
    live,
    agentId,
    attemptId,
    ['link', 'result'],
    options.timeoutMs ?? CLAUDE_SIGN_IN_LINK_WAIT_MS,
  );
  try {
    await notify(database, { agentId, attemptId, step: 'start' });
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  const event = await waiter.answer;
  const failure = failedAnswer(event);
  if (failure) throw failure;
  if (event.step !== 'link' || !event.authorizeUrl) throw new Error(CLAUDE_SIGN_IN_NO_ANSWER_MESSAGE);
  return { attemptId, authorizeUrl: event.authorizeUrl };
}

export async function completeClaudeSignIn(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub,
  agentId: string,
  input: { readonly attemptId: unknown; readonly code: unknown },
  options: { readonly timeoutMs?: number } = {},
): Promise<CompleteClaudeSignInResult> {
  if (typeof input.attemptId !== 'string' || !ATTEMPT_ID.test(input.attemptId))
    throw new Error('sign-in attempt is invalid');
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!code) throw new Error('the code from Claude is required');
  if (code.length > CLAUDE_SIGN_IN_CODE_MAX_LENGTH) throw new Error('the code from Claude is invalid');
  if (!(await agentHelperOnline(database, agentId))) throw new Error(CLAUDE_SIGN_IN_OFFLINE_MESSAGE);
  const attemptId = input.attemptId;
  const waiter = awaitAnswer(
    live,
    agentId,
    attemptId,
    ['result'],
    options.timeoutMs ?? CLAUDE_SIGN_IN_RESULT_WAIT_MS,
  );
  try {
    await notify(database, { agentId, attemptId, step: 'code', code });
  } catch {
    waiter.cancel();
    // A driver error could quote the statement's parameters; never surface it.
    throw new Error(CLAUDE_SIGN_IN_NO_ANSWER_MESSAGE);
  }
  const event = await waiter.answer;
  const failure = failedAnswer(event);
  if (failure) throw failure;
  return { signedIn: true };
}

/** The helper's report for one attempt, relayed to the waiting phone request. */
export async function reportClaudeSignIn(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  input: ReportClaudeSignInInput,
): Promise<void> {
  if (typeof input.attemptId !== 'string' || !ATTEMPT_ID.test(input.attemptId))
    throw new Error('sign-in attempt is invalid');
  const attemptId = input.attemptId;
  if ('authorizeUrl' in input) {
    const url = typeof input.authorizeUrl === 'string' ? input.authorizeUrl : '';
    if (!url.startsWith('https://') || url.length > MAX_REPORT_TEXT)
      throw new Error('sign-in link is invalid');
    await notify(database, { agentId, attemptId, step: 'link', authorizeUrl: url });
    return;
  }
  if (input.outcome === 'signed-in') {
    await notify(database, { agentId, attemptId, step: 'result', outcome: 'signed-in' });
    return;
  }
  if (input.outcome === 'failed') {
    const error = typeof input.error === 'string' ? input.error.trim().slice(0, MAX_REPORT_TEXT) : '';
    await notify(database, {
      agentId,
      attemptId,
      step: 'result',
      outcome: 'failed',
      error: error || 'Sign in to Claude failed on the agent machine.',
    });
    return;
  }
  throw new Error('sign-in report is invalid');
}

const CARD_TYPE = 'claude-sign-in';

type StoredCard = {
  agentId: string;
  ownerId: string;
  status: string;
  sourceMessageId?: string;
  attemptId?: string;
  authorizeUrl?: string;
};

async function settleCard(
  database: Pick<SqlDatabase, 'query'>,
  messageId: string,
  patch: Record<string, string>,
  clearError: boolean,
): Promise<void> {
  await database.query(
    `UPDATE messages SET card=(CASE WHEN $3 THEN card-'errorMessage' ELSE card END)||$2::jsonb
     WHERE id=$1 AND card_type='${CARD_TYPE}'`,
    [messageId, JSON.stringify(patch), clearError],
  );
}

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * After an `@agent login` message commits, ask the agent's machine for its
 * claude.ai link and put it on the card, or settle the card with why not.
 */
export async function beginClaudeSignInCards(
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
    try {
      const started = await startClaudeSignIn(database, live, card.agentId, options);
      await settleCard(
        database,
        id,
        { status: 'pending', attemptId: started.attemptId, authorizeUrl: started.authorizeUrl },
        true,
      );
    } catch (error) {
      await settleCard(database, id, { status: 'failed', errorMessage: failureText(error) }, false);
    }
  }
}

/**
 * The owner pastes Claude's code into a sign-in card. Only the agent's
 * current owner, still in the Room, may complete it; the code is relayed and
 * never stored. A rejected code leaves the card open for another paste.
 */
export async function completeClaudeSignInCard(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub,
  input: { readonly roomId: unknown; readonly messageId: unknown; readonly code: unknown },
  viewerId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<CompleteClaudeSignInResult> {
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
  if (!card.attemptId || (card.status !== 'pending' && card.status !== 'failed'))
    throw new Error('this sign-in is not waiting for a code');
  await settleCard(database, input.messageId, { status: 'signing-in' }, true);
  try {
    const result = await completeClaudeSignIn(
      database,
      live,
      card.agentId,
      { attemptId: card.attemptId, code: input.code },
      options,
    );
    await settleCard(database, input.messageId, { status: 'signed-in' }, true);
    return result;
  } catch (error) {
    await settleCard(
      database,
      input.messageId,
      { status: 'failed', errorMessage: failureText(error) },
      false,
    );
    throw error;
  }
}
