import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqlDatabase } from './database.js';
import { recordFreeAgentEvent, tokenHash, type FreeAgentConfig } from './free-agents.js';

/**
 * The only model access a free agent's Machine has: an OpenAI-compatible
 * `chat/completions` endpoint authenticated by the agent's revocable model
 * token. The server pins the model, adds the OpenRouter key and charges the
 * owner's daily allowance (and a lifetime one, when configured). The allowance counts uncached
 * prompt tokens plus completion tokens; cached prompt reads are not counted.
 */
export interface FreeAgentModelProxyOptions {
  database: SqlDatabase;
  config: Pick<FreeAgentConfig, 'model' | 'dailyTokenCap' | 'lifetimeTokenCap'>;
  upstreamKey: string;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Tokens one response charges against the allowance. */
export function chargedTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const cached = Math.min(prompt, Math.max(0, Number(usage.prompt_tokens_details?.cached_tokens) || 0));
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  return prompt - cached + completion;
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
 * An upper bound on a request's prompt tokens: no tokenizer this proxy serves
 * packs fewer than two characters into a token.
 */
export function promptTokenBound(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body.messages ?? []).length / 2) +
    Math.ceil(JSON.stringify(body.tools ?? []).length / 2);
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
): Promise<{ reserved: number; maxOutput: number } | { limit: 'daily' | 'lifetime' }> {
  return database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`free-agent-usage:${ownerId}`]);
    const used = await freeAgentAllowance(db, ownerId, now);
    const daily = config.dailyTokenCap - used.today;
    const lifetime =
      config.lifetimeTokenCap > 0 ? config.lifetimeTokenCap - used.lifetime : Number.POSITIVE_INFINITY;
    const room = Math.min(daily, lifetime) - promptTokens;
    if (room < MINIMUM_CALL_TOKENS) return { limit: lifetime <= daily ? 'lifetime' : 'daily' };
    const maxOutput = Math.min(room, requestedOutput ?? DEFAULT_OUTPUT_RESERVATION);
    const reserved = promptTokens + maxOutput;
    await adjustUsage(db, ownerId, now.toISOString().slice(0, 10), reserved);
    return { reserved, maxOutput };
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
           WHERE model_token_hash=$1 AND state NOT IN ('failed','destroyed')`,
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
  } catch (error) {
    sendJson(response, 400, { error: { message: error instanceof Error ? error.message : 'invalid request' } });
    return true;
  }
  const now = options.now?.() ?? new Date();
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
  );
  if ('limit' in reservation) {
    await recordFreeAgentEvent(options.database, agent.agent_id, 'allowance_reached', { limit: reservation.limit });
    sendAssistantText(response, stream, options.config.model, allowanceMessage(reservation.limit, options.config));
    return true;
  }
  const day = now.toISOString().slice(0, 10);
  // Settle the reservation once: the reported usage when known, nothing for a
  // call the upstream refused, and the whole reservation when a reply broke off.
  const settle = (spent: number) =>
    adjustUsage(options.database, agent.owner_id, day, spent - reservation.reserved).catch((error) =>
      console.error('[free-agents] usage charge failed', error),
    );
  const upstreamBase = (options.upstreamBaseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const openRouter = new URL(upstreamBase).hostname.endsWith('openrouter.ai');
  const upstreamBody = {
    ...body,
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
    max_completion_tokens: undefined,
    // OpenRouter's own usage flag; other OpenAI-compatible hosts refuse it.
    ...(openRouter ? { usage: { include: true } } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  const abort = new AbortController();
  response.on('close', () => abort.abort());
  let upstream: Response;
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
    await settle(0);
    if (!response.headersSent)
      sendJson(response, 502, { error: { message: `model upstream unavailable: ${String(error)}` } });
    return true;
  }
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  response.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-store' });
  if (!upstream.body) {
    await settle(upstream.ok ? reservation.reserved : 0);
    response.end();
    return true;
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
    reported ? Math.min(chargedTokens(reported), reservation.reserved)
      : upstream.ok ? reservation.reserved : 0,
  );
  response.end();
  return true;
}
