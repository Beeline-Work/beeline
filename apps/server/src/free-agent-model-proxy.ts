import { commandOwnerLiveSql } from './turn-ownership.js';
import { freeAgentModelTakesImages, imageInput, withoutImageData } from './free-agent-image-input.js';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_FREE_AGENT_LIMITS, FREE_AGENT_BUDGET_MESSAGE, freeAgentTokenCapAt, type FreeAgentLimits } from './free-agent-limits.js';
import type { SqlDatabase } from './database.js';
import { warnFreeAgentOwner } from './free-agent-warning.js';
import { recordFreeAgentEvent, tokenHash, type FreeAgentConfig } from './free-agents.js';
import { FreeAgentPromptCache, promptTextBytes } from './free-agent-prompt-budget.js';
import { OwnedModelAttempts, OwnedModelUnknownPayload, type OwnedModelAttemptReceipt, type OwnedModelEvidence, type OwnedModelReservation } from './owned-model-attempt.js';
import { OwnedModelCredentials, type AuthenticatedOwnedModel } from './owned-model-credential.js';
import { CommandRefusalError } from './command-refusal.js';

const promptCache = new FreeAgentPromptCache();
// Shared across all in-flight calls for one owner/day, including other servers.
// Even a complete cache miss cannot add more than this much admission risk.
const MAX_RESERVATION_CREDIT = 32_768;

/**
 * The only model access a free agent's Machine has: an OpenAI-compatible
 * `chat/completions` endpoint authenticated by the agent's revocable model
 * token. The server pins the model, adds the OpenRouter key and charges the
 * owner's daily allowance (and a lifetime one, when configured), including
 * weighted cached reads. A live turn and shared dollar budget are required.
 */
export interface FreeAgentModelProxyOptions {
  database: SqlDatabase;
  config: Pick<FreeAgentConfig, 'model' | 'dailyTokenCap' | 'firstDayTokenCap' | 'lifetimeTokenCap' | 'limits'>;
  upstreamKey: string;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Absent until schema, installed helper negotiation and claim hook are ready.
   * This does not opt legacy per-agent credentials into owned authority. */
  ownedModel?: Readonly<{
    credentials: OwnedModelCredentials;
    ready(): boolean;
    /** Synchronous server-known model evidence only; absent means text-only. */
    acceptsImages?(model: string): boolean;
  }>;
}

interface Usage {
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Request fields a Machine may set. Everything else is dropped, so it cannot
 * name fallback models (`models`), pick providers or plugins, or ask for
 * several replies (`n`) on the server's key.
 */
const FORWARDED_FIELDS = [
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'response_format',
  'reasoning',
  'reasoning_effort',
] as const;

/** The caller's request reduced to the fields a Machine may set. */
export function forwardedFields(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(FORWARDED_FIELDS.filter((key) => key in body).map((key) => [key, body[key]]));
}

/** Tokens one response charges against the allowance. */
export function chargedTokens(usage: Usage | undefined, weight = 0.25): number {
  if (!usage) return 0;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const cached = Math.min(prompt, Math.max(0, Number(usage.prompt_tokens_details?.cached_tokens) || 0));
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  return prompt - cached + completion + Math.ceil(cached * weight);
}

export function allowanceMessage(
  kind: 'daily' | 'lifetime',
  config: Pick<FreeAgentConfig, 'dailyTokenCap' | 'lifetimeTokenCap'>,
  used?: number,
): string {
  const tokens = (value: number) =>
    value >= 1_000_000 ? `${value / 1_000_000}M` : `${Math.round(value / 1000)}K`;
  const cap = kind === 'daily' ? config.dailyTokenCap : config.lifetimeTokenCap;
  if (used !== undefined && used < cap) return `This request is too large for my remaining free allowance (${tokens(used)} of ${tokens(cap)} tokens used). I have to pause ${kind === 'daily' ? 'until it resets at midnight UTC' : 'until you connect your own agent from Members'}.`;
  return kind === 'daily'
    ? `I've used today's free allowance (${tokens(config.dailyTokenCap)} tokens), so I have to pause until it resets at midnight UTC. To keep going now, connect your own agent: open Members, tap Add agent, and follow the steps.`
    : `I've used all of my free allowance (${tokens(config.lifetimeTokenCap)} tokens in total), so I can't take on more work. To keep going, connect your own agent: open Members, tap Add agent, and follow the steps.`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('model request too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** The one existing model transport leaf. Both adapters supply final bytes;
 * no caller authorization/identity header is ever forwarded upstream. */
function requestModelUpstream(options: FreeAgentModelProxyOptions, body: string, signal: AbortSignal): Promise<Response> {
  const upstreamBase = (options.upstreamBaseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  return (options.fetchImpl ?? fetch)(`${upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.upstreamKey}`, 'content-type': 'application/json',
      'x-title': 'Beeline free agent', 'http-referer': 'https://usebeeline.app',
    },
    body, signal,
  });
}

function modelPayload(body: Record<string, unknown>, model: string, maxOutput: number, openRouter: boolean): Record<string, unknown> {
  return {
    ...forwardedFields(body),
    ...(openRouter ? {} : { messages: (body.messages as unknown[]).map(message => {
      if (!message || typeof message !== 'object') return message;
      const { reasoning_content: _reasoning, ...rest } = message as Record<string, unknown>;
      return rest;
    }) }),
    model, max_tokens: maxOutput,
    ...(openRouter ? { usage: { include: true } } : {}),
    ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
  };
}

/** A complete assistant reply, in the shape the caller asked for. */
function sendAssistantText(
  response: ServerResponse,
  stream: boolean,
  model: string,
  text: string,
): void {
  const id = `chatcmpl-beeline-${randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    sendJson(response, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  response.write(chunk({ role: 'assistant', content: text }, null));
  response.write(chunk({}, 'stop'));
  response.end('data: [DONE]\n\n');
}

export async function freeAgentAllowance(
  database: Pick<SqlDatabase, 'query'>,
  ownerId: string,
  now: Date,
): Promise<{ today: number; lifetime: number }> {
  const row = (
    await database.query<{ today: string | number; lifetime: string | number }>(
      `SELECT COALESCE(SUM(tokens) FILTER (WHERE day=$2::date),0) today,
              COALESCE(SUM(tokens),0) lifetime
       FROM free_agent_usage WHERE owner_id=$1`,
      [ownerId, now.toISOString().slice(0, 10)],
    )
  ).rows[0];
  return { today: Number(row?.today ?? 0), lifetime: Number(row?.lifetime ?? 0) };
}

/** Adjust today's usage by a signed amount (a reservation, or its reconciliation). */
async function adjustUsage(
  database: Pick<SqlDatabase, 'query'>,
  ownerId: string,
  day: string,
  tokens: number,
  credit = 0,
): Promise<void> {
  if (tokens === 0 && credit === 0) return;
  await database.query(
    `INSERT INTO free_agent_usage(owner_id,day,tokens,reservation_credit)
     VALUES($1,$2::date,GREATEST($3::bigint,0),GREATEST($4::bigint,0))
     ON CONFLICT(owner_id,day) DO UPDATE SET tokens=GREATEST(free_agent_usage.tokens+$3::bigint,0),
       reservation_credit=GREATEST(free_agent_usage.reservation_credit+$4::bigint,0)`,
    [ownerId, day, tokens, credit],
  );
}

/** Output a reply may use when the request names no smaller bound. */
const DEFAULT_OUTPUT_RESERVATION = 8_192;
/** Below this many tokens of room, a call is refused as over the allowance. */
const MINIMUM_CALL_TOKENS = 256;

/**
 * Estimate model-facing text plus framing overhead. Count schemas and tool
 * selectors, but not repeated reasoning-fragment transport envelopes.
 * DeepSeek v4.1 flash measurements gave
 * 6.0 bytes/token for English and 4.9 for Arabic; dividing by 3 leaves margin.
 * This is an estimate, not a tokenizer guarantee for arbitrary input.
 */
export function promptTokenBound(body: Record<string, unknown>): number {
  return Math.ceil(promptTextBytes(withoutImageData(forwardedFields(body))) / 3) + 256 + imageInput(body, true);
}

/**
 * Reserve estimated prompt tokens plus bounded output before a call runs.
 * Serialized per owner across server instances, so concurrent reservations fit
 * the daily cap (or a configured lifetime cap); the reply's output is
 * bounded by what remains. Returns the reservation, or the cap reached.
 */
export async function reserveAllowance(
  database: SqlDatabase,
  ownerId: string,
  now: Date,
  config: Pick<FreeAgentConfig, 'dailyTokenCap' | 'lifetimeTokenCap'>,
  promptTokens: number,
  requestedOutput: number | undefined,
  limits: FreeAgentLimits = DEFAULT_FREE_AGENT_LIMITS,
  budgetPromptTokens = promptTokens,
  promptUpperBound = promptTokens,
): Promise<{ reserved: number; maxOutput: number; reservedUsd: number; credit: number } | { limit: 'daily' | 'lifetime' | 'budget' | 'rate' }> {
  return database.transaction(async (db) => {
    // Every reservation takes locks in the same order across server instances.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('free-agent-global-budget'))`);
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`free-agent-usage:${ownerId}`]);
    const day = now.toISOString().slice(0, 10);
    const budget = Number((await db.query<{ usd: string }>(
      `SELECT usd FROM free_agent_budget WHERE day=$1::date`, [day],
    )).rows[0]?.usd ?? 0);
    if (budget >= limits.dailyBudgetUsd) return { limit: 'budget' };
    const minute = Math.floor(now.getTime() / 60_000);
    const rate = (await db.query<{ minute: string; calls: number }>(
      `SELECT minute,calls FROM free_agent_call_rate WHERE owner_id=$1`, [ownerId],
    )).rows[0];
    if (rate && Number(rate.minute) === minute && rate.calls >= limits.callsPerMinute) return { limit: 'rate' };
    const used = await freeAgentAllowance(db, ownerId, now);
    const outstanding = Number((await db.query<{ reservation_credit: string }>(
      `SELECT reservation_credit FROM free_agent_usage WHERE owner_id=$1 AND day=$2::date`, [ownerId, day],
    )).rows[0]?.reservation_credit ?? 0);
    // The estimate (including any trusted warm-cache discount) is bounded by
    // a cold byte ceiling minus a small, owner-wide pool of admission credit.
    const reservedPrompt = Math.max(promptTokens, promptUpperBound - Math.max(0, MAX_RESERVATION_CREDIT - outstanding));
    const credit = Math.max(0, promptUpperBound - reservedPrompt);
    const daily = config.dailyTokenCap - used.today;
    const lifetime =
      config.lifetimeTokenCap > 0 ? config.lifetimeTokenCap - used.lifetime : Number.POSITIVE_INFINITY;
    const room = Math.min(daily, lifetime) - reservedPrompt;
    if (room < MINIMUM_CALL_TOKENS) return { limit: lifetime <= daily ? 'lifetime' : 'daily' };
    const dollarRoom = limits.dailyBudgetUsd - budget - budgetPromptTokens * limits.inputUsdPerMillion / 1_000_000;
    const affordableOutput = Math.floor(dollarRoom * 1_000_000 / limits.outputUsdPerMillion);
    if (affordableOutput < MINIMUM_CALL_TOKENS) return { limit: 'budget' };
    const maxOutput = Math.floor(Math.min(
      room, affordableOutput, requestedOutput ?? DEFAULT_OUTPUT_RESERVATION, limits.maxOutputTokens,
    ));
    const reserved = reservedPrompt + maxOutput;
    await adjustUsage(db, ownerId, now.toISOString().slice(0, 10), reserved, credit);
    const reservedUsd = (budgetPromptTokens * limits.inputUsdPerMillion + maxOutput * limits.outputUsdPerMillion) / 1_000_000;
    await db.query(`INSERT INTO free_agent_budget(day,usd) VALUES($1::date,$2)
      ON CONFLICT(day) DO UPDATE SET usd=free_agent_budget.usd+$2`, [day, reservedUsd]);
    await db.query(`INSERT INTO free_agent_call_rate(owner_id,minute,calls) VALUES($1,$2,1)
      ON CONFLICT(owner_id) DO UPDATE SET minute=$2,calls=CASE WHEN free_agent_call_rate.minute=$2
        THEN free_agent_call_rate.calls+1 ELSE 1 END`, [ownerId, minute]);
    return { reserved, maxOutput, reservedUsd, credit };
  });
}

/** Process-wide cap on upstream model calls in flight. Extra calls wait in arrival order. */
export class FreeAgentCallGate {
  #running = 0;
  #waiting: Array<() => void> = [];

  constructor(readonly limit: number) {}

  /** Resolves with the slot's release, or undefined if the signal aborts or the deadline passes first. */
  acquire(signal: AbortSignal, deadline: number): Promise<(() => void) | undefined> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    };
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.#running < this.limit && !this.#waiting.length) {
      this.#running += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      const done = (granted: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(granted ? release : undefined);
      };
      const grant = () => done(true);
      const cancel = () => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        done(false);
      };
      const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
      signal.addEventListener('abort', cancel, { once: true });
      this.#waiting.push(grant);
    });
  }
}

const callGates = new Map<number, FreeAgentCallGate>();

function callGate(limit: number): FreeAgentCallGate {
  let gate = callGates.get(limit);
  if (!gate) callGates.set(limit, (gate = new FreeAgentCallGate(limit)));
  return gate;
}

/**
 * How long OpenRouter retries an in-flight budget refusal. Only the waits after
 * a refusal count; time queued at the call gate does not.
 */
const IN_FLIGHT_RETRY_WINDOW_MS = 3 * 60_000;
/** Wait used when a refusal names no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/** A `Retry-After` header (seconds or an HTTP date) in milliseconds. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    if (header.trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

/** Wait, unless the signal aborts first. Returns false on abort. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve(true);
    }, Math.max(0, ms));
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** Find the last `usage` object in an OpenAI-style SSE stream. */
export class StreamUsageReader {
  #buffer = '';
  usage: Usage | undefined;
  done = false;

  push(text: string): void {
    this.#buffer += text;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') this.done = true;
        if (data && data !== '[DONE]' && data.includes('"usage"')) {
          try {
            const parsed = JSON.parse(data) as { usage?: Usage };
            if (parsed.usage) this.usage = parsed.usage;
          } catch {
            // A partial or foreign line carries no usage.
          }
        }
      }
      newline = this.#buffer.indexOf('\n');
    }
  }
}

/**
 * Handle `POST /v1/free-agents/model/chat/completions`. Returns false when the
 * path is not this proxy's.
 */
export async function handleFreeAgentModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: FreeAgentModelProxyOptions,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/free-agents/model/')) return false;
  if (request.method !== 'POST' || pathname !== '/v1/free-agents/model/chat/completions') {
    sendJson(response, 404, { error: { message: 'not found' } });
    return true;
  }
  const header = request.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.startsWith('bfmc_')) return handleOwnedFreeAgentModel(request, response, token, options);
  const agent = token.startsWith('bfm_')
    ? (
        await options.database.query<{ agent_id: string; owner_id: string; model: string | null }>(
          `SELECT agent_id,owner_id,model FROM free_agents
           WHERE model_token_hash=$1 AND removed_at IS NULL AND state NOT IN ('failed','destroyed')`,
          [tokenHash(token)],
        )
      ).rows[0]
    : undefined;
  if (!agent) {
    sendJson(response, 401, { error: { message: 'invalid free agent model token' } });
    return true;
  }
  // Only the server-stored choice can select a model; request bodies cannot.
  options = { ...options, config: { ...options.config, model: agent.model ?? options.config.model } };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) throw new Error('messages required');
    const hasImages = body.messages.some(message => Array.isArray(message?.content) &&
      message.content.some((part: { type?: string }) => part?.type === 'image_url'));
    imageInput(body, hasImages && await freeAgentModelTakesImages(options.config.model));
  } catch (error) {
    sendJson(response, 400, { error: { message: error instanceof Error ? error.message : 'invalid request' } });
    return true;
  }
  const now = options.now?.() ?? new Date();
  const limits = options.config.limits ?? DEFAULT_FREE_AGENT_LIMITS;
  // A first-day owner gets the larger allowance so a few hours of real work fits.
  const config = {
    ...options.config,
    dailyTokenCap: await freeAgentTokenCapAt(options.database, agent.owner_id, now, options.config),
  };
  const turn = (await options.database.query<{ started: Date | string; room_id: string; turn_request_id: string }>(
    `SELECT command.room_id,command.turn_request_id,COALESCE(turn.started_at,command.claimed_at) started FROM agent_commands command LEFT JOIN agent_turns turn
       ON turn.agent_id=command.agent_id AND turn.room_id=command.room_id
         AND turn.request_id=command.turn_request_id
       WHERE command.agent_id=$1 AND command.state='claimed'
         AND command.action IN ('input','resume') AND ${commandOwnerLiveSql('command', '$2')}
         -- A per-agent model token does not identify a new connection's execution.
         -- The owned cohort stays closed until this transport binds that actor.
         AND command.turn_owner_connection_id IS NULL
         AND COALESCE(turn.started_at,command.claimed_at)>$2::timestamptz-make_interval(secs => $3::double precision / 1000)
       ORDER BY started DESC LIMIT 1`,
    [agent.agent_id, now, limits.maxTurnMs],
  )).rows[0];
  if (!turn) {
    sendJson(response, 403, { error: { message: 'free agent model access requires a live turn' } });
    return true;
  }
  return executeFreeAgentModel(response, body, agent, turn, options);
}

interface ModelAgent { agent_id: string; owner_id: string; model: string | null }
interface ModelTurn { started: Date | string; room_id: string; turn_request_id: string }

class OwnedModelAllowanceRefusal extends CommandRefusalError {
  constructor(readonly limit: 'daily' | 'lifetime' | 'budget' | 'rate') {
    super('Owned model allowance is unavailable', limit === 'rate' ? 429 : 403);
  }
}
function ownedOutcome(response: ServerResponse, receipt: OwnedModelAttemptReceipt): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  sendJson(response, 409, { error: {
    code: receipt.state === 'unknown' ? 'owned_model_unknown' : 'owned_model_recorded',
    message: receipt.state === 'unknown' ? 'Model request outcome is UNKNOWN; do not resubmit.' : 'Model request already has a recorded outcome; do not resubmit.',
  }, receipt });
}
function waitOwned<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(new Error('Owned model request ended')); };
    const cleanup = () => signal.removeEventListener('abort', stop);
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
}
function ownedUsage(value: Usage | undefined, limits: FreeAgentLimits): { tokens: number; usd: number } | undefined {
  if (!value || ![value.prompt_tokens, value.completion_tokens, value.prompt_tokens_details?.cached_tokens ?? 0]
    .every(count => Number.isSafeInteger(count) && Number(count) >= 0)) return;
  const tokens = chargedTokens(value, limits.cachedTokenWeight);
  const usd = typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost :
    (value.prompt_tokens! * limits.inputUsdPerMillion + value.completion_tokens! * limits.outputUsdPerMillion) / 1_000_000;
  if (!Number.isSafeInteger(tokens) || !Number.isFinite(usd) || usd < 0) return;
  return { tokens, usd };
}

/** Closed selected cohort at the existing endpoint. There is deliberately no
 * latest-command lookup, timer retry, streamed-answer replay or legacy fallback.
 * Schema/signer/claim/installed-helper negotiation must all precede ready(). */
async function handleOwnedFreeAgentModel(request: IncomingMessage, response: ServerResponse, token: string,
  options: FreeAgentModelProxyOptions): Promise<boolean> {
  const selected = options.ownedModel;
  if (!selected?.ready()) {
    sendJson(response, 401, { error: { code: 'owned_model_unavailable', message: 'Owned model access is unavailable' } }); return true;
  }
  let actor: AuthenticatedOwnedModel;
  try { actor = await selected.credentials.authenticate(options.database, token); }
  catch {
    sendJson(response, 401, { error: { code: 'owned_model_authority', message: 'Owned model authority is unavailable' } }); return true;
  }
  const id = request.headers['x-beeline-model-request'];
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    sendJson(response, 400, { error: { message: 'Owned model request identity is required' } }); return true;
  }
  const binding = selected.credentials.actor(actor), limits = options.config.limits ?? DEFAULT_FREE_AGENT_LIMITS;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) throw new Error('messages required');
    // No public model-metadata network read. Initial text-only compatibility is
    // an explicit activation gate until pinned modality evidence is supplied.
    imageInput(body, selected.acceptsImages?.(binding.model) === true);
  } catch {
    sendJson(response, 400, { error: { message: 'Invalid owned model request' } }); return true;
  }
  const stream = body.stream === true, now = options.now?.() ?? new Date(), day = now.toISOString().slice(0, 10);
  const requested = [body.max_tokens, body.max_completion_tokens].map(Number).filter(value => Number.isFinite(value) && value > 0);
  const requestedOutput = requested.length ? Math.min(...requested) : undefined;
  const upstreamBase = (options.upstreamBaseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const openRouter = new URL(upstreamBase).hostname.endsWith('openrouter.ai');
  const semantic = modelPayload(body, binding.model, requestedOutput ?? DEFAULT_OUTPUT_RESERVATION, openRouter);
  const cacheBody = { ...forwardedFields(body), model: binding.model, upstream: upstreamBase };
  const cacheKey = `${binding.agentId}:${day}`, estimated = promptTokenBound(body);
  const cached = Math.min(estimated, promptCache.cached(cacheKey, cacheBody, now.getTime()));
  const attempts = new OwnedModelAttempts(options.database, selected.credentials);
  let admitted: Awaited<ReturnType<OwnedModelAttempts['reserve']>>;
  try {
    admitted = await attempts.reserve(actor, id, semantic, async tx => {
      const config = { ...options.config, dailyTokenCap: await freeAgentTokenCapAt(tx, binding.ownerId, now, options.config) };
      const reserved = await reserveAllowance(tx, binding.ownerId, now, config,
        estimated - cached + Math.ceil(cached * limits.cachedTokenWeight), requestedOutput, limits,
        Buffer.byteLength(JSON.stringify(withoutImageData(forwardedFields(body))), 'utf8') + 256 + imageInput(body, true),
        promptTextBytes(withoutImageData(forwardedFields(body))) + 256 + imageInput(body, true));
      if ('limit' in reserved) throw new OwnedModelAllowanceRefusal(reserved.limit);
      return { reservation: { ...reserved, day }, payload: modelPayload(body, binding.model, reserved.maxOutput, openRouter) };
    });
  } catch (error) {
    if (error instanceof CommandRefusalError) sendJson(response, error.status, { error: {
      code: error instanceof OwnedModelAllowanceRefusal ? 'owned_model_allowance' : error instanceof OwnedModelUnknownPayload ? 'owned_model_unknown' : 'owned_model_refused', message: error.message,
    } });
    else sendJson(response, 503, { error: { code: 'owned_model_unknown', message: 'Model request admission is uncertain; do not resubmit.' } });
    return true;
  }
  if (!admitted.permit) { ownedOutcome(response, admitted.receipt); return true; }
  const permit = admitted.permit;
  const settle = async (tx: SqlDatabase, reservation: OwnedModelReservation, evidence: OwnedModelEvidence): Promise<void> => {
    const tokens = evidence.kind === 'usage' ? evidence.tokens : 0, usd = evidence.kind === 'usage' ? evidence.usd : 0;
    await adjustUsage(tx, binding.ownerId, reservation.day, tokens - reservation.reserved, -reservation.credit);
    await tx.query(`UPDATE free_agent_budget SET usd=GREATEST(0,usd+$2) WHERE day=$1::date`, [reservation.day, usd - reservation.reservedUsd]);
    await recordFreeAgentEvent(tx, binding.agentId, 'model_usage', { day: reservation.day, tokens, usd, modelRequestId: id });
  };
  const abort = new AbortController(), close = () => abort.abort();
  response.once('close', close);
  const deadline = Math.min(binding.expiresMs, Date.now() + limits.maxTurnMs);
  const timer = setTimeout(close, Math.max(0, deadline - Date.now()));
  let release: (() => void) | undefined;
  const knownNonentry = async (reason: 'authority' | 'queue' | 'cancelled' | 'deadline') => {
    try { ownedOutcome(response, await attempts.refuseBeforeHandoff(permit, reason, settle)); }
    catch { ownedOutcome(response, admitted.receipt); }
  };
  try {
    release = await callGate(limits.maxConcurrentCalls).acquire(abort.signal, deadline);
    if (!release || abort.signal.aborted || Date.now() >= deadline) {
      await knownNonentry(abort.signal.aborted ? 'cancelled' : 'deadline'); return true;
    }
    let started: { state: 'started'; completion: Promise<Response> } | { state: 'unknown'; completion?: Promise<Response> };
    try { started = await attempts.handoff(permit, bytes => {
      if (abort.signal.aborted || Date.now() >= deadline) throw new Error('Owned model deadline ended before handoff');
      return requestModelUpstream(options, bytes, abort.signal);
    }); }
    catch { await knownNonentry('authority'); return true; }
    if (started.state === 'unknown') {
      abort.abort();
      void started.completion?.then(upstream => upstream.body?.cancel()).catch(() => {});
      ownedOutcome(response, admitted.receipt); return true;
    }
    let upstream: Response;
    void started.completion.then(result => {
      if (abort.signal.aborted) void result.body?.cancel().catch(() => {});
    }).catch(() => {});
    try { upstream = await waitOwned(started.completion, abort.signal); }
    catch { ownedOutcome(response, admitted.receipt); return true; }
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      if ([400, 401, 402, 403, 404, 413, 422, 429].includes(upstream.status)) {
        try { ownedOutcome(response, await attempts.refuseFromProvider(actor, id, upstream.status, settle)); }
        catch { ownedOutcome(response, admitted.receipt); }
      } else ownedOutcome(response, admitted.receipt);
      return true;
    }
    if (!upstream.body) { ownedOutcome(response, admitted.receipt); return true; }
    const reader = upstream.body.getReader(), decoder = new TextDecoder(), usage = new StreamUsageReader();
    let whole = '', bytes = 0, complete = false, reported: Usage | undefined;
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    try {
      for (;;) {
        const next = await waitOwned(reader.read(), abort.signal); if (next.done) { complete = true; break; }
        bytes += next.value.byteLength; if (bytes > MAX_REQUEST_BYTES) throw new Error('Owned model response exceeds capacity');
        const text = decoder.decode(next.value, { stream: true });
        if (stream) usage.push(text); else whole += text;
        response.write(next.value);
      }
      if (stream) { reported = usage.usage; complete &&= usage.done; }
      else {
        const result = JSON.parse(whole) as { usage?: Usage; choices?: unknown };
        reported = result.usage; complete &&= Array.isArray(result.choices);
      }
    } catch { complete = false; }
    finally { if (!complete) { abort.abort(); void reader.cancel().catch(() => {}); } reader.releaseLock(); }
    const observed = ownedUsage(reported ?? usage.usage, limits);
    // Only complete terminal evidence can release any of this reservation.
    // A usage object before a lost delimiter does not prove final billing.
    if (observed && complete && !abort.signal.aborted) {
      try {
        await attempts.settleUsage(actor, id, observed, 'succeeded', settle);
        promptCache.observe(cacheKey, cacheBody, Math.min(Math.max(0, Number((reported ?? usage.usage)?.prompt_tokens) || 0),
          Math.max(0, Number((reported ?? usage.usage)?.prompt_tokens_details?.cached_tokens) || 0)), now.getTime());
      } catch { complete = false; }
    }
    // Even a clean stream without valid usage leaves conservative UNKNOWN and
    // its original reservation. A lost answer is never reconstructed/replayed.
    if (!complete) response.destroy(); else response.end();
    return true;
  } finally {
    clearTimeout(timer); response.removeListener('close', close); release?.();
  }
}

async function executeFreeAgentModel(response: ServerResponse, body: Record<string, unknown>,
  agent: ModelAgent, turn: ModelTurn, options: FreeAgentModelProxyOptions, signal?: AbortSignal): Promise<boolean> {
  const now = options.now?.() ?? new Date();
  const limits = options.config.limits ?? DEFAULT_FREE_AGENT_LIMITS;
  options = { ...options, config: { ...options.config, model: agent.model ?? options.config.model } };
  const config = { ...options.config,
    dailyTokenCap: await freeAgentTokenCapAt(options.database, agent.owner_id, now, options.config) };
  const stream = body.stream === true;
  const requested = [body.max_tokens, body.max_completion_tokens]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const forwarded = forwardedFields(body);
  const cacheBody = { ...forwarded, model: options.config.model,
    upstream: options.upstreamBaseUrl ?? 'https://openrouter.ai/api/v1' };
  const cacheKey = `${agent.agent_id}:${now.toISOString().slice(0, 10)}`;
  const estimated = promptTokenBound(body);
  const cached = Math.min(estimated, promptCache.cached(cacheKey, cacheBody, now.getTime()));
  const reservation = await reserveAllowance(
    options.database,
    agent.owner_id,
    now,
    config,
    estimated - cached + Math.ceil(cached * limits.cachedTokenWeight),
    requested.length ? Math.min(...requested) : undefined,
    limits,
    // Keep the dollar budget's existing byte-based worst-case reservation.
    Buffer.byteLength(JSON.stringify(withoutImageData(forwarded)), 'utf8') + 256 + imageInput(body, true),
    promptTextBytes(withoutImageData(forwarded)) + 256 + imageInput(body, true),
  );
  if ('limit' in reservation) {
    if (reservation.limit === 'rate') {
      sendJson(response, 429, { error: { message: 'Free agent call limit reached. Try again next minute.' } });
      return true;
    }
    if (reservation.limit === 'budget') {
      await recordFreeAgentEvent(options.database, agent.agent_id, 'budget_reached');
      sendAssistantText(response, stream, options.config.model, FREE_AGENT_BUDGET_MESSAGE);
      return true;
    }
    await recordFreeAgentEvent(options.database, agent.agent_id, 'allowance_reached', {
      limit: reservation.limit, roomId: turn.room_id, requestId: turn.turn_request_id,
    });
    const used = await freeAgentAllowance(options.database, agent.owner_id, now);
    const reset = reservation.limit === 'daily'
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) : null;
    await options.database.transaction(async db => {
      await db.query(`UPDATE free_agents SET allowance_paused_until=COALESCE($2::timestamptz,'infinity'::timestamptz) WHERE owner_id=$1`, [agent.owner_id, reset]);
      await db.query(`UPDATE agent_commands command SET startup_wake_after=GREATEST(command.startup_wake_after,starter.allowance_paused_until)
        FROM free_agents starter WHERE starter.owner_id=$1 AND starter.agent_id=command.agent_id
        AND command.state='pending' AND command.action IN ('input','resume')`, [agent.owner_id]);
    });
    sendAssistantText(response, stream, options.config.model, allowanceMessage(reservation.limit, config, reservation.limit === 'daily' ? used.today : used.lifetime));
    return true;
  }
  const day = now.toISOString().slice(0, 10);
  // Settle the reservation once: the reported usage when known, nothing for a
  // failed or interrupted call. Never keep a worst-case dollar reservation for an aborted reply.
  const settle = (spent: number, usd: number) =>
    options.database.transaction(async db => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('free-agent-global-budget'))`);
      await adjustUsage(db, agent.owner_id, day, spent - reservation.reserved, -reservation.credit);
      await db.query(`UPDATE free_agent_budget SET usd=GREATEST(0,usd+$2) WHERE day=$1::date`,
        [day, usd - reservation.reservedUsd]);
      await recordFreeAgentEvent(db, agent.agent_id, 'model_usage', { day, tokens: spent, usd });
    }).then(async () => {
      if (spent > 0) await warnFreeAgentOwner(options.database, agent.agent_id, agent.owner_id, day, config.dailyTokenCap, turn.room_id);
    }).catch(error => console.error('[free-agents] usage charge or warning failed', error));
  const upstreamBase = (options.upstreamBaseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const openRouter = new URL(upstreamBase).hostname.endsWith('openrouter.ai');
  const upstreamBody = modelPayload(body, options.config.model, reservation.maxOutput, openRouter);
  const abort = new AbortController();
  response.on('close', () => abort.abort());
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  if (signal?.aborted) abort.abort();
  // Queued calls keep their reservation, so they give up when the turn cap ends or the caller leaves.
  const turnDeadline = new Date(turn.started).getTime() + limits.maxTurnMs;
  const forwardUpstream = async (): Promise<void> => {
    let upstream: Response;
    let retryUntil: number | undefined;
    for (;;) {
      try {
        upstream = await requestModelUpstream(options, JSON.stringify(upstreamBody), abort.signal);
      } catch (error) {
        await settle(0, 0);
        if (!response.headersSent)
          sendJson(response, 502, { error: { message: `model upstream unavailable: ${String(error)}` } });
        return;
      }
      if (upstream.status !== 402) break;
      // OpenRouter refuses a call that does not fit the account's in-flight
      // budget; it fits once running calls finish. Nothing has reached the
      // caller yet, so retry within the window. Other refusals pass through.
      const refusal = await upstream.text().catch(() => '');
      let reason: unknown;
      try {
        reason = (JSON.parse(refusal) as { error?: { metadata?: { reason?: unknown } } }).error?.metadata?.reason;
      } catch {
        reason = undefined;
      }
      const passThrough = async () => {
        await settle(0, 0);
        response.writeHead(402, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        });
        response.end(refusal);
      };
      retryUntil ??= Math.min(Date.now() + IN_FLIGHT_RETRY_WINDOW_MS, turnDeadline);
      const wait = retryAfterMs(upstream.headers.get('retry-after'));
      // Retry only when the wait ends inside the window and the turn.
      if (reason !== 'in_flight_budget_exhausted' || wait >= retryUntil - Date.now()) {
        await passThrough();
        return;
      }
      if (!await pause(wait, abort.signal)) {
        await settle(0, 0);
        return;
      }
      if (Date.now() >= retryUntil) {
        await passThrough();
        return;
      }
    }
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    response.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-store' });
    if (!upstream.body) {
      await settle(upstream.ok ? reservation.reserved : 0, upstream.ok ? reservation.reservedUsd : 0);
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const usage = new StreamUsageReader();
    let whole = '';
    let interrupted = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (stream) usage.push(text);
        else if (whole.length < MAX_REQUEST_BYTES) whole += text;
        response.write(value);
      }
    } catch {
      // Refund token reservations when an interrupted reply has no reported usage.
      interrupted = true;
    }
    let reported: Usage | undefined = usage.usage;
    if (!stream && upstream.ok) {
      try {
        reported = (JSON.parse(whole) as { usage?: Usage }).usage;
      } catch {
        reported = undefined;
      }
    }
    // Settle before the reply completes, so the next request sees this one.
    promptCache.observe(cacheKey, cacheBody,
      upstream.ok && reported ? Math.min(Math.max(0, Number(reported.prompt_tokens) || 0),
        Math.max(0, Number(reported.prompt_tokens_details?.cached_tokens) || 0)) : 0,
      now.getTime());
    await settle(
      reported ? chargedTokens(reported, limits.cachedTokenWeight)
        : upstream.ok && !interrupted && !abort.signal.aborted ? reservation.reserved : 0,
      !upstream.ok ? 0 : reported
        ? (typeof reported.cost === 'number' && Number.isFinite(reported.cost) && reported.cost >= 0
          ? reported.cost
          : (Math.max(0, Number(reported.prompt_tokens) || 0) * limits.inputUsdPerMillion +
             Math.max(0, Number(reported.completion_tokens) || 0) * limits.outputUsdPerMillion) / 1_000_000)
        : interrupted || abort.signal.aborted ? 0 : reservation.reservedUsd,
    );
    response.end();
  };
  const release = await callGate(limits.maxConcurrentCalls).acquire(abort.signal, turnDeadline);
  if (!release) {
    await settle(0, 0);
    if (!response.headersSent)
      sendJson(response, 503, { error: { message: 'free agent model busy; try again' } });
    return true;
  }
  try {
    await forwardUpstream();
  } finally {
    release();
  }
  return true;
}

/** Server-owned onboarding calls share admission, queueing and settlement with helper turns.
 * The persisted run binds the caller to the newly created team; HTTP callers cannot select this path.
 */
export async function completeStarterBanter(options: FreeAgentModelProxyOptions, runId: string,
  agentId: string, messages: { role: string; content: string }[], signal: AbortSignal): Promise<string> {
  const agent = (await options.database.query<ModelAgent & { room_id: string }>(
    `SELECT f.agent_id,f.owner_id,f.model,r.room_id FROM starter_onboarding_runs r
     JOIN free_agents f ON f.owner_id=r.user_id AND f.agent_id=ANY(ARRAY[r.beebee_id,r.luna_id])
     JOIN memberships m ON m.identity_id=f.agent_id AND m.room_id=r.room_id AND m.removed_at IS NULL
     WHERE r.id=$1 AND f.agent_id=$2 AND f.removed_at IS NULL AND f.state NOT IN ('failed','destroyed') AND r.status='generating'
       AND r.created_at>clock_timestamp()-interval '2 minutes'`, [runId, agentId])).rows[0];
  if (!agent) throw new Error('Onboarding generation is no longer active');
  let status = 200;
  let reply = '';
  const capture = new Writable({ write(chunk, _encoding, callback) { reply += chunk.toString(); callback(); } });
  const response = Object.assign(capture, {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; return this; },
  });
  const abort = () => capture.emit('close');
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await executeFreeAgentModel(response as unknown as ServerResponse,
      { messages, stream: false, max_tokens: 4096, reasoning: { exclude: true, ...(agent.model?.startsWith('openai/') ? { effort: 'low' } : {}) } }, agent,
      { room_id: agent.room_id, turn_request_id: runId, started: new Date() }, options, signal);
    if (status !== 200) throw new Error(`Onboarding model returned ${status}`);
    const result = JSON.parse(reply) as { choices?: { message?: { content?: unknown } }[] };
    const text = result.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : '';
  } finally { signal.removeEventListener('abort', abort); }
}
