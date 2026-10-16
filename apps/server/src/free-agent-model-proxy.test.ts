import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import {
  allowanceMessage,
  chargedTokens,
  freeAgentAllowance,
  handleFreeAgentModelRequest,
  StreamUsageReader,
} from './free-agent-model-proxy.js';
import { tokenHash } from './free-agents.js';
import { PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TOKEN = `bfm_${'x'.repeat(43)}`;
const CONFIG = { model: 'deepseek/deepseek-v4-flash', dailyTokenCap: 1_000, lifetimeTokenCap: 5_000 };

describe('free agent model proxy', () => {
  let db: PgliteDatabase;
  let server: Server;
  let origin: string;
  let upstream: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }>;
  let reply: () => Response;

  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Fern')`,
      [OWNER, AGENT],
    );
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await db.query(
      `INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,model_token_hash,state)
       VALUES($1,$2,$3,'sealed',$4,'running')`,
      [AGENT, WORKSPACE, OWNER, tokenHash(TOKEN)],
    );
    upstream = [];
    reply = () =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 300 } },
      });
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      upstream.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return reply();
    }) as typeof fetch;
    server = createServer((request, response) => {
      void handleFreeAgentModelRequest(request, response, new URL(request.url!, 'http://x').pathname, {
        database: db,
        config: CONFIG,
        upstreamKey: 'sk-or-server-only',
        fetchImpl,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  const call = (body: Record<string, unknown>, token = TOKEN) =>
    fetch(`${origin}/v1/free-agents/model/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses a missing or revoked model token', async () => {
    expect((await call({ messages: [] }, 'bfm_nope')).status).toBe(401);
    await db.query(`UPDATE free_agents SET state='failed'`);
    expect((await call({ messages: [] })).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('pins the model, adds the server key and charges uncached prompt plus completion tokens', async () => {
    const response = await call({ model: 'anthropic/claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('done');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(upstream[0]!.authorization).toBe('Bearer sk-or-server-only');
    expect(upstream[0]!.body).toMatchObject({ model: 'deepseek/deepseek-v4-flash', usage: { include: true } });
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 240, lifetime: 240 });
  });

  it('charges a streamed reply from its final usage chunk', async () => {
    reply = () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7}}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const response = await call({ stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(await response.text()).toContain('"llo"');
    expect(upstream[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 107, lifetime: 107 });
  });

  it('answers in the agent voice instead of calling the model once the daily allowance is used', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await db.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,$2::date,1000)`, [OWNER, day]);
    const plain = await (await call({ messages: [{ role: 'user', content: 'more' }] })).json();
    expect(plain.choices[0].message.content).toBe(allowanceMessage('daily', CONFIG));
    expect(plain.choices[0].message.content).toContain('connect your own agent');
    const streamed = await (await call({ stream: true, messages: [{ role: 'user', content: 'more' }] })).text();
    expect(streamed).toContain('data: [DONE]');
    expect(streamed).toContain("today's free allowance");
    expect(upstream).toEqual([]);
    expect(
      (await db.query(`SELECT detail FROM free_agent_events WHERE kind='allowance_reached'`)).rows,
    ).toEqual([{ detail: { limit: 'daily' } }, { detail: { limit: 'daily' } }]);
  });

  it('stops for good at the lifetime allowance, across days', async () => {
    await db.query(
      `INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,'2026-01-01',3000),($1,'2026-01-02',2000)`,
      [OWNER],
    );
    const body = await (await call({ messages: [{ role: 'user', content: 'more' }] })).json();
    expect(body.choices[0].message.content).toBe(allowanceMessage('lifetime', CONFIG));
    expect(upstream).toEqual([]);
  });

  it('never lets concurrent calls spend past the daily cap, and bounds each reply to what remains', async () => {
    // 1,000-token daily cap. Every call is held at the upstream until all have
    // arrived, so each one must have been admitted against the same balance.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const admitted: Array<{ max_tokens: unknown }> = [];
    reply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 50, completion_tokens: 300 } });
    const held = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      admitted.push(JSON.parse(String(init?.body)));
      await gate;
      return reply();
    };
    server.removeAllListeners('request');
    server.on('request', (request, response) => {
      void handleFreeAgentModelRequest(request, response, new URL(request.url!, 'http://x').pathname, {
        database: db,
        config: CONFIG,
        upstreamKey: 'sk-or-server-only',
        fetchImpl: held as typeof fetch,
      });
    });
    const calls = Array.from({ length: 8 }, () =>
      call({ max_tokens: 100_000, messages: [{ role: 'user', content: 'go' }] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    const bodies = await Promise.all(calls.map(async (pending) => (await (await pending).json()).choices[0].message.content));
    // The admitted calls' reservations fit the cap; the rest were told the allowance is used.
    const reservedOutput = admitted.reduce((total, body) => total + Number(body.max_tokens), 0);
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.length).toBeLessThan(8);
    expect(reservedOutput).toBeLessThanOrEqual(CONFIG.dailyTokenCap);
    expect(admitted.every((body) => Number(body.max_tokens) < 100_000)).toBe(true);
    expect(bodies.filter((text) => text === allowanceMessage('daily', CONFIG))).toHaveLength(8 - admitted.length);
    const spent = await freeAgentAllowance(db, OWNER, new Date());
    expect(spent.today).toBeLessThanOrEqual(CONFIG.dailyTokenCap);
  });

  it('refunds a call the upstream refused', async () => {
    reply = () => new Response('{"error":{"message":"busy"}}', { status: 503, headers: { 'content-type': 'application/json' } });
    expect((await call({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(503);
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 0, lifetime: 0 });
  });

  it('counts tokens conservatively from partial usage', () => {
    expect(chargedTokens(undefined)).toBe(0);
    expect(chargedTokens({ prompt_tokens: 10, completion_tokens: 5 })).toBe(15);
    expect(chargedTokens({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } })).toBe(0);
    const reader = new StreamUsageReader();
    reader.push('data: {"usage":{"prompt_tokens":3');
    reader.push(',"completion_tokens":4}}\n\ndata: [DONE]\n');
    expect(reader.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
  });
});
