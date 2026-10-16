import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_FREE_AGENT_LIMITS, FREE_AGENT_BUDGET_MESSAGE, type FreeAgentLimits } from './free-agent-limits.js';
import type { SqlDatabase } from './database.js';
import { warnFreeAgentOwner } from './free-agent-warning.js';
import { recordFreeAgentEvent, tokenHash, type FreeAgentConfig } from './free-agents.js';

/**
 * The only model access a free agent's Machine has: an OpenAI-compatible
 * `chat/completions` endpoint authenticated by the agent's revocable model
 * token. The server pins the model, adds the OpenRouter key and charges the
 * owner's daily allowance (and a lifetime one, when configured), including
 * weighted cached reads. A live turn and shared dollar budget are required.
 */
export interface FreeAgentModelProxyOptions {
  database: SqlDatabase;
  config: Pick<FreeAgentConfig, 'model' | 'dailyTokenCap' | 'lifetimeTokenCap' | 'limits'>;
  upstreamKey: string;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
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
): string {
  const tokens = (value: number) =>
    value >= 1_000_000 ? `${value / 1_000_000}M` : `${Math.round(value / 1000)}K`;
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
): Promise<void> {
  if (tokens === 0) return;
  await database.query(
    `INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,$2::date,GREATEST($3::bigint,0))
     ON CONFLICT(owner_id,day) DO UPDATE SET tokens=GREATEST(free_agent_usage.tokens+$3::bigint,0)`,
    [ownerId, day, tokens],
  );
}

/** Output a reply may use when the request names no smaller bound. */
const DEFAULT_OUTPUT_RESERVATION = 8_192;
/** Below this many tokens of room, a call is refused as over the allowance. */
const MINIMUM_CALL_TOKENS = 256;

/**
 * Bound every forwarded field by UTF-8 bytes plus framing overhead. Schemas
 * and tool selectors can also contribute model input, so use the forwarding
 * allowlist itself to keep reservations conservative when fields are added.
 */
export function promptTokenBound(body: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(forwardedFields(body)), 'utf8') + 256;
}

/**
 * Reserve a call's worst case against the owner's allowance before it runs.
 * Serialized per owner across server instances, so concurrent calls can never
 * together spend past the daily cap (or a configured lifetime cap); the reply's output is
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
): Promise<{ reserved: number; maxOutput: number; reservedUsd: number } | { limit: 'daily' | 'lifetime' | 'budget' | 'rate' }> {
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
    const daily = config.dailyTokenCap - used.today;
    const lifetime =
      config.lifetimeTokenCap > 0 ? config.lifetimeTokenCap - used.lifetime : Number.POSITIVE_INFINITY;
    const room = Math.min(daily, lifetime) - promptTokens;
    if (room < MINIMUM_CALL_TOKENS) return { limit: lifetime <= daily ? 'lifetime' : 'daily' };
    const dollarRoom = limits.dailyBudgetUsd - budget - promptTokens * limits.inputUsdPerMillion / 1_000_000;
    const affordableOutput = Math.floor(dollarRoom * 1_000_000 / limits.outputUsdPerMillion);
    if (affordableOutput < MINIMUM_CALL_TOKENS) return { limit: 'budget' };
    const maxOutput = Math.floor(Math.min(
      room, affordableOutput, requestedOutput ?? DEFAULT_OUTPUT_RESERVATION, limits.maxOutputTokens,
    ));
    const reserved = promptTokens + maxOutput;
    await adjustUsage(db, ownerId, now.toISOString().slice(0, 10), reserved);
    const reservedUsd = (promptTokens * limits.inputUsdPerMillion + maxOutput * limits.outputUsdPerMillion) / 1_000_000;
    await db.query(`INSERT INTO free_agent_budget(day,usd) VALUES($1::date,$2)
      ON CONFLICT(day) DO UPDATE SET usd=free_agent_budget.usd+$2`, [day, reservedUsd]);
    await db.query(`INSERT INTO free_agent_call_rate(owner_id,minute,calls) VALUES($1,$2,1)
      ON CONFLICT(owner_id) DO UPDATE SET minute=$2,calls=CASE WHEN free_agent_call_rate.minute=$2
        THEN free_agent_call_rate.calls+1 ELSE 1 END`, [ownerId, minute]);
    return { reserved, maxOutput, reservedUsd };
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

  push(text: string): void {
    this.#buffer += text;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
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
  const agent = token.startsWith('bfm_')
    ? (
        await options.database.query<{ agent_id: string; owner_id: string }>(
          `SELECT agent_id,owner_id FROM free_agents
           WHERE model_token_hash=$1 AND removed_at IS NULL AND state NOT IN ('failed','destroyed')`,
          [tokenHash(token)],
        )
      ).rows[0]
    : undefined;
  if (!agent) {
    sendJson(response, 401, { error: { message: 'invalid free agent model token' } });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) throw new Error('messages required');
    for (const message of body.messages) {
      if (!message || typeof message !== 'object') throw new Error('invalid message');
      if (Array.isArray(message.content) && message.content.some((part: { type?: string }) => part?.type !== 'text'))
        throw new Error('free agent model requests support text content only');
    }
  } catch (error) {
    sendJson(response, 400, { error: { message: error instanceof Error ? error.message : 'invalid request' } });
    return true;
  }
  const now = options.now?.() ?? new Date();
  const limits = options.config.limits ?? DEFAULT_FREE_AGENT_LIMITS;
  const turn = (await options.database.query<{ started: Date | string }>(
    `SELECT COALESCE(turn.started_at,command.claimed_at) started FROM agent_commands command LEFT JOIN agent_turns turn
       ON turn.agent_id=command.agent_id AND turn.room_id=command.room_id
         AND turn.request_id=command.turn_request_id
       WHERE command.agent_id=$1 AND command.state='claimed'
         AND command.action IN ('input','resume') AND command.lease_expires_at>$2
         AND COALESCE(turn.started_at,command.claimed_at)>$2::timestamptz-make_interval(secs => $3::double precision / 1000)
       ORDER BY started DESC LIMIT 1`,
    [agent.agent_id, now, limits.maxTurnMs],
  )).rows[0];
  if (!turn) {
    sendJson(response, 403, { error: { message: 'free agent model access requires a live turn' } });
    return true;
  }
  const stream = body.stream === true;
  const requested = [body.max_tokens, body.max_completion_tokens]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const reservation = await reserveAllowance(
    options.database,
    agent.owner_id,
    now,
    options.config,
    promptTokenBound(body),
    requested.length ? Math.min(...requested) : undefined,
    limits,
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
    await recordFreeAgentEvent(options.database, agent.agent_id, 'allowance_reached', { limit: reservation.limit });
    sendAssistantText(response, stream, options.config.model, allowanceMessage(reservation.limit, options.config));
    return true;
  }
  const day = now.toISOString().slice(0, 10);
  // Settle the reservation once: the reported usage when known, nothing for a
  // call the upstream refused, and the whole reservation when a reply broke off.
  const settle = (spent: number, usd = reservation.reservedUsd) =>
    options.database.transaction(async db => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('free-agent-global-budget'))`);
      await adjustUsage(db, agent.owner_id, day, spent - reservation.reserved);
      await db.query(`UPDATE free_agent_budget SET usd=GREATEST(0,usd+$2) WHERE day=$1::date`,
        [day, usd - reservation.reservedUsd]);
      await recordFreeAgentEvent(db, agent.agent_id, 'model_usage', { day, tokens: spent, usd });
    }).then(async () => {
      if (spent > 0) await warnFreeAgentOwner(options.database, agent.agent_id, agent.owner_id, day, options.config.dailyTokenCap);
    }).catch(error => console.error('[free-agents] usage charge or warning failed', error));
  const upstreamBase = (options.upstreamBaseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const openRouter = new URL(upstreamBase).hostname.endsWith('openrouter.ai');
  const upstreamBody = {
    ...forwardedFields(body),
    // Strict OpenAI-compatible hosts refuse the reasoning a harness replays.
    ...(openRouter
      ? {}
      : {
          messages: (body.messages as unknown[]).map((message) => {
            if (!message || typeof message !== 'object') return message;
            const { reasoning_content: _reasoning, ...rest } = message as Record<string, unknown>;
            return rest;
          }),
        }),
    model: options.config.model,
    // The reservation bounds the reply; a larger client bound is dropped.
    max_tokens: reservation.maxOutput,
    // OpenRouter's own usage flag; other OpenAI-compatible hosts refuse it.
    ...(openRouter ? { usage: { include: true } } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  const abort = new AbortController();
  response.on('close', () => abort.abort());
  // Queued calls keep their reservation, so they give up when the turn cap ends or the caller leaves.
  const turnDeadline = new Date(turn.started).getTime() + limits.maxTurnMs;
  const forwardUpstream = async (): Promise<void> => {
    let upstream: Response;
    let retryUntil: number | undefined;
    for (;;) {
      try {
        upstream = await (options.fetchImpl ?? fetch)(
          `${upstreamBase}/chat/completions`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.upstreamKey}`,
              'content-type': 'application/json',
              'x-title': 'Beeline free agent',
              'http-referer': 'https://usebeeline.app',
            },
            body: JSON.stringify(upstreamBody),
            signal: abort.signal,
          },
        );
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
      // The caller went away or the upstream broke; settle on what was reported.
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
    await settle(
      reported ? chargedTokens(reported, limits.cachedTokenWeight)
        : upstream.ok ? reservation.reserved : 0,
      !upstream.ok ? 0 : reported
        ? (typeof reported.cost === 'number' && Number.isFinite(reported.cost) && reported.cost >= 0
          ? reported.cost
          : (Math.max(0, Number(reported.prompt_tokens) || 0) * limits.inputUsdPerMillion +
             Math.max(0, Number(reported.completion_tokens) || 0) * limits.outputUsdPerMillion) / 1_000_000)
        : reservation.reservedUsd,
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
