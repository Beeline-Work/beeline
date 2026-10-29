import { freeAgentModelTakesImages, IMAGE_TOKEN_RESERVATION } from './free-agent-image-input.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import {
  allowanceMessage,
  chargedTokens,
  freeAgentAllowance,
  handleFreeAgentModelRequest,
  StreamUsageReader,
  reserveAllowance,
  retryAfterMs,
  promptTokenBound,
  type FreeAgentModelProxyOptions,
} from './free-agent-model-proxy.js';
import { freeAgentConfigFromEnv, tokenHash } from './free-agents.js';
import { DEFAULT_FREE_AGENT_LIMITS, FREE_AGENT_BUDGET_MESSAGE, freeAgentLimitsFromEnv } from './free-agent-limits.js';
import { PgliteDatabase } from './test-support.js';
import { projectAgentUsage } from './agent-usage.js';
import { PhoneService } from './phone-service.js';

vi.mock('./free-agent-image-input.js', async importOriginal => ({
  ...await importOriginal<typeof import('./free-agent-image-input.js')>(),
  freeAgentModelTakesImages: vi.fn(async () => false),
}));

const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TOKEN = `bfm_${'x'.repeat(43)}`;
const ENABLED_ENV = { BEELINE_FREE_AGENT_SEAL_KEY: 'seal', FLY_FREE_AGENT_IMAGE: 'image' };
const CONFIG = { model: 'deepseek/deepseek-v4-flash', dailyTokenCap: 1_000, firstDayTokenCap: 1_000, lifetimeTokenCap: 5_000 };

describe('free agent model proxy', () => {
  let db: PgliteDatabase;
  let server: Server;
  let origin: string;
  let upstream: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }>;
  let reply: (signal?: AbortSignal | null) => Response;
  let config: FreeAgentModelProxyOptions['config'];

  beforeEach(async () => {
    vi.mocked(freeAgentModelTakesImages).mockResolvedValue(false);
    config = { ...CONFIG };
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
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,visibility) VALUES($1,$2,$3,'General','public')`, [ROOM, WORKSPACE, OWNER]);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state,claimed_at,lease_expires_at)
      VALUES('turn',$1,$2,'request','input','human_tag','turn','source',0,'claimed',now(),now()+interval '90 seconds')`, [ROOM, AGENT]);
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
      return reply(init?.signal);
    }) as typeof fetch;
    server = createServer((request, response) => {
      void handleFreeAgentModelRequest(request, response, new URL(request.url!, 'http://x').pathname, {
        database: db,
        config,
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

  it('pins each teammate to its stored model and charges the same owner allowance', async () => {
    const luna = 'c'.repeat(64);
    const lunaToken = `bfm_${'y'.repeat(43)}`;
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Luna')`, [luna]);
    await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,model_token_hash,state,model)
      VALUES($1,$2,$3,'sealed',$4,'running','openai/gpt-6-luna')`, [luna, WORKSPACE, OWNER, tokenHash(lunaToken)]);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state,claimed_at,lease_expires_at)
      VALUES('luna-turn',$1,$2,'luna-request','input','human_tag','luna-turn','source',0,'claimed',now(),now()+interval '90 seconds')`, [ROOM, luna]);
    config = { ...CONFIG, dailyTokenCap: 10_000, firstDayTokenCap: 10_000 };
    for (const token of [TOKEN, lunaToken]) {
      const response = await call({ model: 'attacker/model', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 50 }, token);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(upstream.map(request => request.body.model)).toEqual([CONFIG.model, 'openai/gpt-6-luna']);
    const usage = (await db.query(`SELECT owner_id,tokens FROM free_agent_usage`)).rows;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ owner_id: OWNER });
    expect(Number(usage[0]!.tokens)).toBe(2 * (200 + 40 + 75));
  });

  it.each([false, true])('R-REASONING-POST: preserves separate reasoning and tool arguments (stream=%s)', async (stream) => {
    const args = JSON.stringify({ text: 'Final **reply** stays unchanged.' });
    const message = { role: 'assistant', content: null, reasoning_content: 'PRIVATE_SENTINEL',
      reasoning_details: [{ type: 'reasoning.text', text: 'PRIVATE_SENTINEL', index: 0 }],
      tool_calls: [{ id: 'post-1', type: 'function', function: { name: 'post', arguments: args } }] };
    const wire = stream
      ? `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: message.reasoning_content } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: message.tool_calls } }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message }] });
    reply = () => new Response(wire, { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
    const response = await call({ messages: [{ role: 'user', content: 'Reply using post' }], stream });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(wire);
  });

  it('Reproduction SUB0ZERO-admission: admits the reconstructed refusal size and settles exact usage', async () => {
    config = { ...CONFIG, dailyTokenCap: 3_000_000, lifetimeTokenCap: 0 };
    await db.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,current_date,2135302)`, [OWNER]);
    // Content-free stand-in for the 14:56:48 request: 31,901 transport
    // fragments, 244,809 reasoning-text bytes, 2,719,303 total message bytes.
    const details = Array.from({ length: 31_901 }, (_, i) => ({ type: 'reasoning.text',
      text: 'r'.repeat(i < 244_809 % 31_901 ? 8 : 7), format: 'unknown', index: 0 }));
    const messages = [{ role: 'user', content: '' }, { role: 'assistant', reasoning_details: details }];
    messages[0]!.content = 'x'.repeat(2_719_303 - Buffer.byteLength(JSON.stringify({ messages })));
    const body = { messages, max_tokens: 1024 };
    expect(Math.ceil(Buffer.byteLength(JSON.stringify({ messages })) / 3) + 256).toBe(906_691);
    expect(promptTokenBound(body)).toBeLessThan(864_698);
    reply = () => Response.json({ choices: [{ message: { content: 'admitted' } }],
      usage: { prompt_tokens: 170_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 165_000 } } });
    expect((await (await call(body)).json()).choices[0].message.content).toBe('admitted');
    expect(upstream).toHaveLength(1);
    expect((upstream[0]!.body.messages as unknown[])[1]).toMatchObject({ reasoning_details: details });
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(2_135_302 + 46_750);
    expect(Number((await db.query(`SELECT reservation_credit FROM free_agent_usage`)).rows[0]!.reservation_credit)).toBe(0);
    console.log(`Demonstrated SUB0ZERO-admission: old message-only estimate 906691 > 864698 remaining; new estimate ${promptTokenBound(body)}; HTTP reply admitted; exact settlement 2182052.`);
  });

  it('discounts an observed matching warm prefix at 0.25 and settles an ensuing cache miss exactly', async () => {
    config = { ...CONFIG, dailyTokenCap: 100_000, lifetimeTokenCap: 0 };
    const body = { stream: true, messages: [{ role: 'user', content: 'prior context '.repeat(300) }], max_tokens: 1024 };
    reply = () => new Response('data: {"usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":900}}}\n\ndata: [DONE]\n\n');
    await (await call(body)).text();
    let finish!: () => void;
    reply = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
      finish = () => {
        controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":1000,"completion_tokens":10}}\n\ndata: [DONE]\n\n'));
        controller.close();
      };
    } }));
    const response = await call(body);
    const expectedReservation = promptTokenBound(body) - 900 + 225 + 1024;
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(335 + expectedReservation);
    finish();
    await response.text();
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(335 + 1010);
    expect(Number((await db.query(`SELECT reservation_credit FROM free_agent_usage`)).rows[0]!.reservation_credit)).toBe(0);
  });

  it('bounds aggregate reservation uncertainty across parallel owner calls, even with a total cache miss', async () => {
    const now = new Date();
    const calls = await Promise.all(Array.from({ length: 8 }, () => reserveAllowance(db, OWNER, now,
      { ...CONFIG, dailyTokenCap: 1_000_000, lifetimeTokenCap: 0 }, 2_500, 256, DEFAULT_FREE_AGENT_LIMITS, 50_000, 50_000)));
    const admitted = calls.filter(call => 'reserved' in call);
    expect(admitted).toHaveLength(8);
    const credits = admitted.reduce((sum, call) => sum + call.credit, 0);
    expect(credits).toBe(32_768);
    expect(admitted.reduce((sum, call) => sum + call.reserved, 0)).toBe(8 * (50_000 + 256) - 32_768);
    expect(Number((await db.query(`SELECT reservation_credit FROM free_agent_usage`)).rows[0]!.reservation_credit)).toBe(32_768);
  });

  it.each(['deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-luna'])(
    'Reproduction free-agent-images-1: forwards a photo to pinned %s and settles image usage', async model => {
      vi.mocked(freeAgentModelTakesImages).mockResolvedValue(true);
      await db.query('UPDATE free_agents SET model=$1 WHERE agent_id=$2', [model, AGENT]);
      config = { ...CONFIG, dailyTokenCap: 1_000_000, firstDayTokenCap: 1_000_000, lifetimeTokenCap: 0 };
      const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
      const body = { model: 'attacker/model', messages: [{ role: 'user', content: [
        { type: 'text', text: 'What is in this picture?' }, image,
      ] }], max_tokens: 50 };
      expect(promptTokenBound(body)).toBeGreaterThan(IMAGE_TOKEN_RESERVATION);
      reply = () => Response.json({ choices: [{ message: { content: 'A photo description' } }],
        usage: { prompt_tokens: 2200, completion_tokens: 40 } });
      const response = await call(body);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('A photo description');
      expect(freeAgentModelTakesImages).toHaveBeenCalledWith(model);
      expect(upstream[0]!.body).toMatchObject({ model, messages: body.messages });
      expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(2240);
      console.log(`Demonstrated free-agent-images-1: ${model} image forwarded unchanged; reported image usage charged (2240 tokens). Provider response is a stand-in.`);
    });

  it('counts image input against admission when provider usage is absent', async () => {
    vi.mocked(freeAgentModelTakesImages).mockResolvedValue(true);
    const body = { messages: [{ role: 'user', content: [{ type: 'image_url',
      image_url: { url: 'https://example.com/photo.jpg' } }] }], max_tokens: 50 };
    const refused = await call(body);
    expect(await refused.text()).toContain("free allowance");
    expect(upstream).toHaveLength(0);
    config = { ...CONFIG, dailyTokenCap: 1_000_000, firstDayTokenCap: 1_000_000, lifetimeTokenCap: 0 };
    reply = () => Response.json({ choices: [{ message: { content: 'photo' } }] });
    const accepted = await call(body);
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(promptTokenBound(body) + 50);
  });

  it.each([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100_000) } }] },
    { role: 'user', content: 'data:image/png;base64,' + 'A'.repeat(100_000) },
  ])('refuses unsupported binary input before reservation instead of counting it as text', async message => {
    expect((await call({ messages: [message] })).status).toBe(400);
    expect(upstream).toEqual([]);
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(0);
  });

  it('Reproduction luna-encrypted-1: forwards replayed encrypted reasoning and counts it in full', async () => {
    config = { ...CONFIG, dailyTokenCap: 1_000_000, lifetimeTokenCap: 0 };
    const encrypted = { type: 'reasoning.encrypted', data: 'A'.repeat(100_000), index: 0 };
    const body = { messages: [{ role: 'user', content: 'Your move' },
      { role: 'assistant', content: 'ok', reasoning_details: [encrypted] }], max_tokens: 1024 };
    expect(promptTokenBound(body)).toBeGreaterThan(100_000 / 3);
    const response = await call(body);
    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect((upstream[0]!.body.messages as unknown[])[1]).toMatchObject({ reasoning_details: [encrypted] });
    console.log('Demonstrated luna-encrypted-1: encrypted reasoning replay HTTP 200, forwarded unchanged.');
  });

  it('Reproduction free-allowance-bytes-overcount: forwards 180 KB at 123478 of 300000 tokens used', async () => {
    config = { ...CONFIG, dailyTokenCap: 300_000, lifetimeTokenCap: 0 };
    await db.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,current_date,123478)`, [OWNER]);
    const body = { messages: [{ role: 'user', content: 'Please summarize the conversation. '.repeat(5_455) }], max_tokens: 1024 };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(180_000);
    const response = await call(body);
    expect((await response.json()).choices[0].message.content).toBe('done');
    expect(upstream).toHaveLength(1);
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(123_478 + 315);
  });

  it('keeps the original dollar reservation while estimating allowance tokens', async () => {
    config = { ...CONFIG, dailyTokenCap: 1_000_000, lifetimeTokenCap: 0,
      limits: { ...DEFAULT_FREE_AGENT_LIMITS, dailyBudgetUsd: 0.1 } };
    const body = { messages: [{ role: 'user', content: 'Please summarize the conversation. '.repeat(5_455) }], max_tokens: 1024 };
    expect((await (await call(body)).json()).choices[0].message.content).toBe(FREE_AGENT_BUDGET_MESSAGE);
    expect(upstream).toEqual([]);
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(0);
  });

  it('Reproduction FREE-ABUSE-1: refuses an idle copied token without upstream use or charge; a live turn passes', async () => {
    await db.query(`UPDATE agent_commands SET state='complete',completed_at=now()`);
    expect((await call({ messages: [] })).status).toBe(403);
    expect(upstream).toEqual([]);
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 0, lifetime: 0 });
    await db.query(`UPDATE agent_commands SET state='claimed'`);
    expect((await call({ messages: [] })).status).toBe(200);
    expect(upstream).toHaveLength(1);
    console.log('Demonstrated FREE-ABUSE-1: outside turn HTTP 403, zero upstream calls and charge; live turn HTTP 200.');
  });

  it('refuses the former model token after the owner removes the free agent through Members', async () => {
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [WORKSPACE, OWNER, AGENT]);
    const phone = new PhoneService(db, origin);
    await phone.execute('removeAgent', { workspaceId: WORKSPACE, agentId: AGENT }, OWNER);
    expect((await call({ messages: [] })).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('atomically limits parallel owner calls per minute and allows the next minute', async () => {
    const limits = { ...DEFAULT_FREE_AGENT_LIMITS, callsPerMinute: 2 };
    const now = new Date('2026-10-16T12:00:00Z');
    const config = { ...CONFIG, dailyTokenCap: 100_000 };
    const calls = await Promise.all(Array.from({ length: 8 }, () => reserveAllowance(db, OWNER, now, config, 10, 256, limits)));
    expect(calls.filter(call => 'reserved' in call)).toHaveLength(2);
    expect(calls.filter(call => 'limit' in call && call.limit === 'rate')).toHaveLength(6);
    expect(await reserveAllowance(db, OWNER, new Date(now.getTime() + 60_000), config, 10, 256, limits)).toHaveProperty('reserved');
  });

  it('reserves global dollars before parallel calls from different owners', async () => {
    const owners = Array.from({ length: 8 }, (_, i) => String(i).repeat(64));
    for (const owner of owners) await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Budget owner')`, [owner]);
    const limits = { ...DEFAULT_FREE_AGENT_LIMITS, dailyBudgetUsd: 0.002 };
    const calls = await Promise.all(owners.map(owner => reserveAllowance(db, owner, new Date(), CONFIG, 10, 256, limits)));
    expect(calls.filter(call => 'reserved' in call)).toHaveLength(1);
    expect(calls.filter(call => 'limit' in call && call.limit === 'budget')).toHaveLength(7);
    expect(Number((await db.query(`SELECT usd FROM free_agent_budget`)).rows[0]!.usd)).toBeLessThanOrEqual(0.002);
  });

  it('pauses in the agent voice at the global budget without calling upstream', async () => {
    await db.query(`INSERT INTO free_agent_budget(day,usd) VALUES(current_date,25)`);
    const response = await call({ messages: [] });
    expect((await response.json()).choices[0].message.content).toBe(FREE_AGENT_BUDGET_MESSAGE);
    expect(upstream).toEqual([]);
    expect((await db.query(`SELECT kind FROM free_agent_events WHERE kind='budget_reached'`)).rows).toHaveLength(1);
  });

  it('settles OpenRouter dollar usage and falls back to configured prices', async () => {
    reply = () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.000123 } });
    await (await call({ messages: [] })).text();
    expect(Number((await db.query(`SELECT usd FROM free_agent_budget`)).rows[0]!.usd)).toBeCloseTo(0.000123, 8);
    reply = () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
    await (await call({ messages: [] })).text();
    expect(Number((await db.query(`SELECT usd FROM free_agent_budget`)).rows[0]!.usd)).toBeCloseTo(0.000273, 8);
  });

  it('refuses an expired lease and an overlong claimed turn', async () => {
    await db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '1 second'`);
    expect((await call({ messages: [] })).status).toBe(403);
    await db.query(`UPDATE agent_commands SET lease_expires_at=now()+interval '90 seconds',claimed_at=now()-interval '16 minutes'`);
    expect((await call({ messages: [] })).status).toBe(403);
    await db.query(`UPDATE agent_commands SET claimed_at=now()`);
    await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at)
      VALUES($1,'request',$2,'working',now()-interval '16 minutes')`, [ROOM, AGENT]);
    expect((await call({ messages: [] })).status).toBe(403);
    expect(upstream).toEqual([]);
  });

  it('refuses owner calls above the minute limit without calling upstream', async () => {
    const minute = Math.floor(Date.now() / 60_000);
    await db.query(`INSERT INTO free_agent_call_rate(owner_id,minute,calls) VALUES($1,$2,30)`, [OWNER, minute]);
    expect((await call({ messages: [] })).status).toBe(429);
    expect(upstream).toEqual([]);
    await db.query(`UPDATE free_agent_call_rate SET minute=minute-1`);
    expect((await call({ messages: [] })).status).toBe(200);
    expect(upstream).toHaveLength(1);
  });

  it('uses configurable limits and rounds weighted cached tokens upward', () => {
    expect(freeAgentLimitsFromEnv({})).toEqual(DEFAULT_FREE_AGENT_LIMITS);
    expect(freeAgentLimitsFromEnv({ BEELINE_FREE_AGENT_CACHED_TOKEN_WEIGHT: '0.1', BEELINE_FREE_AGENT_CALLS_PER_MINUTE: '5',
      BEELINE_FREE_AGENT_DAILY_BUDGET_USD: '12', BEELINE_FREE_AGENT_MAX_TURN_SECONDS: '60' })).toMatchObject({
      cachedTokenWeight: 0.1, callsPerMinute: 5, dailyBudgetUsd: 12, maxTurnMs: 60_000,
    });
    expect(freeAgentLimitsFromEnv({ BEELINE_FREE_AGENT_MAX_OUTPUT_TOKENS: '16000', BEELINE_FREE_AGENT_MAX_CONCURRENT_CALLS: '3' }))
      .toMatchObject({ maxOutputTokens: 16_000, maxConcurrentCalls: 3 });
    expect(chargedTokens({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 91 } }, 0.1)).toBe(24);
  });

  it.each([
    { limit: 'daily', parallel: 1 },
    { limit: 'daily', parallel: 8 },
    { limit: 'budget', parallel: 1 },
    { limit: 'budget', parallel: 8 },
  ] as const)('FREE-ABUSE-SCHEMA: refuses large response_format schemas before upstream ($limit, $parallel calls)', async ({ limit, parallel }) => {
    if (limit === 'budget') config = {
      ...CONFIG, dailyTokenCap: 200_000, lifetimeTokenCap: 0,
      limits: { ...DEFAULT_FREE_AGENT_LIMITS, dailyBudgetUsd: 0.002 },
    };
    reply = () => Response.json({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 50_000, completion_tokens: 1, cost: 0.05 },
    });
    const request = {
      messages: [{ role: 'user', content: 'Return JSON.' }], max_tokens: 256,
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema: {
        type: 'object', description: 'x'.repeat(100_000),
      } } },
    };
    const bodies = await Promise.all(Array.from({ length: parallel }, async () => (await call(request)).json()));
    const expected = limit === 'daily' ? allowanceMessage('daily', config) : FREE_AGENT_BUDGET_MESSAGE;
    expect(bodies.map(body => body.choices[0].message.content)).toEqual(Array(parallel).fill(expected));
    expect(upstream).toEqual([]);
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 0, lifetime: 0 });
    expect((await db.query(`SELECT usd FROM free_agent_budget`)).rows).toEqual([]);
    console.log(`Demonstrated FREE-ABUSE-SCHEMA: ${parallel} large-schema calls refused by ${limit}; zero upstream, token and dollar charges.`);
  });

  it('forwards a small response_format schema within the allowance', async () => {
    const response_format = { type: 'json_schema', json_schema: { name: 'result', schema: {
      type: 'object', properties: { answer: { type: 'string' } },
    } } };
    expect((await call({ messages: [], response_format, max_tokens: 256 })).status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body.response_format).toEqual(response_format);
  });

  it('refuses a missing or revoked model token', async () => {
    expect((await call({ messages: [] }, 'bfm_nope')).status).toBe(401);
    await db.query(`UPDATE free_agents SET state='failed'`);
    expect((await call({ messages: [] })).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('settles a real model request and posts the 80% warning in the working room', async () => {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,
    [WORKSPACE, ROOM, OWNER, AGENT]);
    reply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 500, completion_tokens: 300 } });
    expect((await call({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200);
    const warning = (await db.query<{ room_id: string }>(`SELECT room_id FROM messages WHERE author_id=$1`, [AGENT])).rows;
    expect(warning).toHaveLength(1);
    expect(warning[0]!.room_id).toBe(ROOM);
    const phone = new PhoneService(db, 'https://server.test');
    const view = await phone.readRoom(ROOM, OWNER);
    expect(view?.messages.map(message => message.text).join(' ')).toContain("I've used 80%");
    expect(upstream).toHaveLength(1);
    await call({ messages: [{ role: 'user', content: 'more' }] });
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='allowance_warning'`)).rowCount).toBe(1);
  });

  it('delivers the near-cap notice in the working room after the first-day threshold, once, and still reads it after refusal', async () => {
    config = { ...CONFIG, dailyTokenCap: 3_000_000, firstDayTokenCap: 10_000_000, lifetimeTokenCap: 0 };
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,
    [WORKSPACE, ROOM, OWNER, AGENT]);
    // The first-day allowance is live, and settled usage sits just below its 80% mark.
    const today = new Date().toISOString().slice(0, 10);
    await db.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,(now() AT TIME ZONE 'UTC')::date,7500000)`, [OWNER]);
    await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail,at) VALUES($1,'model_usage',$2::jsonb,now())`,
      [AGENT, JSON.stringify({ day: today, tokens: 7_500_000 })]);
    reply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 600_000, completion_tokens: 300_000 } });
    expect((await call({ messages: [{ role: 'user', content: 'build the game' }] })).status).toBe(200);
    const phone = new PhoneService(db, 'https://server.test');
    const crossed = await phone.readRoom(ROOM, OWNER);
    expect(crossed?.messages.map(message => message.text).join(' ')).toContain("I've used 80%");
    expect(crossed?.messages.map(message => message.text).join(' ')).toContain('midnight UTC');
    // Within the same UTC day the notice is deduplicated, even through another call.
    reply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
    await call({ messages: [{ role: 'user', content: 'again' }] });
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='allowance_warning'`)).rowCount).toBe(1);
    // Past the first-day cap the owner is refused; the room still reads the one notice.
    await db.query(`UPDATE free_agent_usage SET tokens=10000000 WHERE owner_id=$1`, [OWNER]);
    expect((await (await call({ messages: [{ role: 'user', content: 'more' }] })).json()).choices[0].message.content)
      .toBe(allowanceMessage('daily', { ...config, dailyTokenCap: 10_000_000 }));
    const refused = await phone.readRoom(ROOM, OWNER);
    expect(refused?.messages.map(message => message.text).join(' ')).toContain("I've used 80%");
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='allowance_warning'`)).rowCount).toBe(1);
    console.log('Demonstrated working-room near-cap notice: first-day threshold crossed, one deduplicated notice, still readable after refusal.');
  });

  it('pins the default October model, adds the server key and charges uncached prompt plus completion tokens', async () => {
    config = { ...config, model: freeAgentConfigFromEnv(ENABLED_ENV, 'https://beeline.example')!.model };
    const response = await call({ model: 'anthropic/claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('done');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(upstream[0]!.authorization).toBe('Bearer sk-or-server-only');
    expect(upstream[0]!.body).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash-1017', usage: { include: true } });
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 315, lifetime: 315 });
  });

  it('forwards only the approved model: fallback models, provider routing and extra replies are dropped', async () => {
    const response = await call({
      model: 'anthropic/claude-opus-4.1',
      models: ['anthropic/claude-opus-4.1', 'openai/gpt-6'],
      provider: { order: ['anthropic'], allow_fallbacks: true },
      route: 'fallback',
      plugins: [{ id: 'web' }],
      transforms: ['middle-out'],
      n: 8,
      max_completion_tokens: 100_000,
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'read' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    const sent = upstream[0]!.body;
    expect(sent.model).toBe('deepseek/deepseek-v4-flash');
    for (const key of ['models', 'provider', 'route', 'plugins', 'transforms', 'n', 'max_completion_tokens']) {
      expect(sent, key).not.toHaveProperty(key);
    }
    expect(Object.keys(sent).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature', 'tools', 'usage']);
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
    ).toEqual([
      { detail: { limit: 'daily', roomId: ROOM, requestId: 'request' } },
      { detail: { limit: 'daily', roomId: ROOM, requestId: 'request' } },
    ]);
  });

  it('has no lifetime cap by default: an account past 3M lifetime tokens still spends within its daily cap', async () => {
    expect(freeAgentConfigFromEnv(ENABLED_ENV, 'https://beeline.example')).toMatchObject({
      dailyTokenCap: 3_000_000,
      lifetimeTokenCap: 0,
    });
    await db.query(
      `INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,'2026-01-01',2000000),($1,'2026-01-02',1500000)`,
      [OWNER],
    );
    const uncapped = { ...CONFIG, lifetimeTokenCap: 0 };
    server.removeAllListeners('request');
    server.on('request', (request, response) => {
      void handleFreeAgentModelRequest(request, response, new URL(request.url!, 'http://x').pathname, {
        database: db,
        config: uncapped,
        upstreamKey: 'sk-or-server-only',
        fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
          upstream.push({ url: '', authorization: null, body: JSON.parse(String(init?.body)) });
          return reply();
        }) as typeof fetch,
      });
    });
    const body = await (await call({ messages: [{ role: 'user', content: 'more' }] })).json();
    expect(body.choices[0].message.content).toBe('done');
    expect(upstream).toHaveLength(1);
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 315, lifetime: 3_500_315 });
  });

  it('stops for good at a configured lifetime allowance, across days', async () => {
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

  it('renders the default daily allowance as 3M tokens', () => {
    const defaults = freeAgentConfigFromEnv(ENABLED_ENV, 'https://beeline.example')!;
    expect(defaults.dailyTokenCap).toBe(3_000_000);
    expect(allowanceMessage('daily', defaults)).toContain('(3M tokens)');
  });

  it('Reproduction R-FIRSTDAY: an owner in their first 24 hours passes the daily cap and is refused past the first-day cap', async () => {
    config = { ...CONFIG, dailyTokenCap: 3_000_000, firstDayTokenCap: 10_000_000, lifetimeTokenCap: 0 };
    await db.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,(now() AT TIME ZONE 'UTC')::date,3500000)`, [OWNER]);
    // No model_usage event yet: the owner is in their first day.
    expect((await (await call({ messages: [{ role: 'user', content: 'hi' }] })).json()).choices[0].message.content).toBe('done');
    expect(upstream).toHaveLength(1);
    // Past the first-day cap the owner is refused, naming the first-day size.
    await db.query(`UPDATE free_agent_usage SET tokens=9999999 WHERE owner_id=$1`, [OWNER]);
    expect((await (await call({ messages: [{ role: 'user', content: 'more' }] })).json()).choices[0].message.content)
      .toBe(allowanceMessage('daily', { ...config, dailyTokenCap: 10_000_000 }));
    // A model call from 25 hours ago ends the window; the daily cap applies again.
    await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail,at) VALUES($1,'model_usage','{"day":"x","tokens":0}'::jsonb, now()-interval '25 hours')`, [AGENT]);
    expect((await (await call({ messages: [{ role: 'user', content: 'more' }] })).json()).choices[0].message.content)
      .toBe(allowanceMessage('daily', { ...config, dailyTokenCap: 3_000_000 }));
    console.log('Demonstrated R-FIRSTDAY: 3.5M passed on day one, refused past 10M, refused past 3M once 24h elapsed.');
  });

  it('shows the first-day limit in the owner meter until 24 hours after the first model call', () => {
    vi.stubEnv('BEELINE_FREE_AGENT_DAILY_TOKENS', '3000000');
    vi.stubEnv('BEELINE_FREE_AGENT_FIRST_DAY_TOKENS', '10000000');
    try {
      expect(projectAgentUsage({ usage_free: true, usage_free_first_day: true })?.free?.limit).toBe(10_000_000);
      expect(projectAgentUsage({ usage_free: true, usage_free_first_day: false })?.free?.limit).toBe(3_000_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['750000', 'invalid', '0', '-1', 'Infinity', ''])('keeps configured cap and meter aligned for %s', (value) => {
    vi.stubEnv('BEELINE_FREE_AGENT_DAILY_TOKENS', value);
    try {
      const defaults = freeAgentConfigFromEnv({ ...ENABLED_ENV, BEELINE_FREE_AGENT_DAILY_TOKENS: value }, 'https://beeline.example')!;
      expect(defaults.dailyTokenCap).toBe(value === '750000' ? 750_000 : 3_000_000);
      expect(projectAgentUsage({ usage_free: true })?.free?.limit).toBe(defaults.dailyTokenCap);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('serves requests past 1M and returns the 3M cap message at the default limit', async () => {
    config = freeAgentConfigFromEnv(ENABLED_ENV, 'https://beeline.example')!;
    // A past model call keeps this a steady-state owner under the daily cap.
    await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail,at) VALUES($1,'model_usage','{"tokens":0}'::jsonb,'2026-01-01T00:00:00Z'::timestamptz)`, [AGENT]);
    await db.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1000000)`, [OWNER]);
    expect((await (await call({ messages: [{ role: 'user', content: 'hi' }] })).json()).choices[0].message.content).toBe('done');
    await db.query(`UPDATE free_agent_usage SET tokens=3000000 WHERE owner_id=$1`, [OWNER]);
    const response = await call({ messages: [{ role: 'user', content: 'hi' }] });
    expect((await response.json()).choices[0].message.content).toContain('(3M tokens)');
    expect(upstream).toHaveLength(1);
  });

  it('refunds tokens and dollars when the upstream connection fails', async () => {
    reply = () => { throw new Error('connection reset'); };
    const response = await call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(502);
    await response.text();
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(0);
    expect(Number((await db.query(`SELECT usd FROM free_agent_budget`)).rows[0]!.usd)).toBe(0);
  });

  it('releases tokens after a reply stream fails without usage', async () => {
    reply = () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('upstream stream reset')); },
    }), { headers: { 'content-type': 'text/event-stream' } });
    await (await call({ stream: true, messages: [] })).text();
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(0);
    expect((await db.query(`SELECT detail FROM free_agent_events WHERE kind='model_usage'`)).rows)
      .toMatchObject([{ detail: { tokens: 0, usd: 0 } }]);
  });

  it.each([undefined, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, cost: 0.002 }])('settles an interrupted reply at actual or zero usage: %j', async reported => {
    reply = (signal) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }], ...(reported ? { usage: reported } : {}) }) + '\n\n'));
        // The mock upstream fails like fetch does when its caller disconnects.
        signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const abort = new AbortController();
    const response = await fetch(`${origin}/v1/free-agents/model/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [] }), signal: abort.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(async () => expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(reported?.total_tokens ?? 0));
    expect(Number((await db.query(`SELECT usd FROM free_agent_budget`)).rows[0]!.usd)).toBeCloseTo(reported?.cost ?? 0);
    expect((await db.query(`SELECT detail FROM free_agent_events WHERE kind='model_usage'`)).rows).toMatchObject([{ detail: { tokens: reported?.total_tokens ?? 0, usd: reported?.cost ?? 0 } }]);
  });

  it('counts tokens conservatively from partial usage', () => {
    expect(chargedTokens(undefined)).toBe(0);
    expect(chargedTokens({ prompt_tokens: 10, completion_tokens: 5 })).toBe(15);
    expect(chargedTokens({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } })).toBe(3);
    const reader = new StreamUsageReader();
    reader.push('data: {"usage":{"prompt_tokens":3');
    reader.push(',"completion_tokens":4}}\n\ndata: [DONE]\n');
    expect(reader.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
  });
  it('defaults the reply cap to at least 32,768 tokens and 8 concurrent calls', () => {
    // "8k max tokens is too small."
    expect(DEFAULT_FREE_AGENT_LIMITS.maxOutputTokens).toBeGreaterThanOrEqual(32_768);
    expect(freeAgentLimitsFromEnv({}).maxOutputTokens).toBe(32_768);
    expect(freeAgentLimitsFromEnv({}).maxConcurrentCalls).toBe(8);
  });

  it('FREE-CAP-1: sends a 65,536-token request upstream with max_tokens 32,768', async () => {
    config = { ...CONFIG, dailyTokenCap: 1_000_000, lifetimeTokenCap: 0 };
    expect((await call({ max_tokens: 65_536, messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body.max_tokens).toBe(32_768);
    console.log('Demonstrated FREE-CAP-1: requested 65536 reply tokens; upstream max_tokens 32768.');
  });

  it('FREE-INFLIGHT-1: 20 parallel calls ride out the in-flight 402 with at most 8 upstream calls running', async () => {
    config = { ...CONFIG, dailyTokenCap: 1_000_000, lifetimeTokenCap: 0 };
    const refused = new Set<string>();
    let running = 0;
    let peak = 0;
    let attempts = 0;
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>(resolve => { releaseFirstWave = resolve; });
    const flaky = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      attempts += 1;
      running += 1;
      peak = Math.max(peak, running);
      try {
        // Hold the initial requests until the test observes all eight slots.
        // A fixed sleep can finish before the last request arrives on busy CI.
        if (attempts <= 8) await firstWave;
        else await new Promise((resolve) => setTimeout(resolve, 20));
        const id = String(JSON.parse(String(init?.body)).messages[0].content);
        if (!refused.has(id)) {
          refused.add(id);
          return new Response(JSON.stringify({ error: { code: 402, message: 'in-flight budget exhausted',
            metadata: { reason: 'in_flight_budget_exhausted', limit_source: 'openrouter_in_flight_budget' } } }),
            { status: 402, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
        }
        return reply();
      } finally {
        running -= 1;
      }
    }) as typeof fetch;
    server.removeAllListeners('request');
    server.on('request', (request, response) => {
      void handleFreeAgentModelRequest(request, response, new URL(request.url!, 'http://x').pathname, {
        database: db, config, upstreamKey: 'sk-or-server-only', fetchImpl: flaky,
      });
    });
    const pendingResponses = Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const response = await call({ messages: [{ role: 'user', content: `call ${i}` }] });
      return { status: response.status, content: (await response.json()).choices?.[0]?.message?.content };
    }));
    try {
      await vi.waitFor(() => expect(running).toBe(8), { timeout: 5000 });
    } finally {
      releaseFirstWave();
      await pendingResponses;
    }
    const responses = await pendingResponses;
    expect(responses).toEqual(Array(20).fill({ status: 200, content: 'done' }));
    expect(attempts).toBe(40);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBe(8);
    // Each call settles once, at its reported usage: 200 uncached + 40 completion + ceil(300 * 0.25).
    expect((await freeAgentAllowance(db, OWNER, new Date())).today).toBe(20 * 315);
    console.log(`Demonstrated FREE-INFLIGHT-1: 20/20 calls HTTP 200 after an in-flight 402 each; ${attempts} upstream attempts, peak ${peak} in flight; charged ${20 * 315} tokens once each.`);
  }, 15_000);

  it('passes other 402 refusals through without retry and refunds them', async () => {
    reply = () => new Response(JSON.stringify({ error: { code: 402, message: 'no credits',
      metadata: { reason: 'openrouter_credits' } } }), { status: 402, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    const response = await call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(402);
    expect((await response.json()).error.metadata.reason).toBe('openrouter_credits');
    expect(upstream).toHaveLength(1);
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 0, lifetime: 0 });
  });

  it.each([
    { name: 'a 1 s turn cap', limits: { maxTurnMs: 1_000 }, retryAfter: '120' },
    { name: 'the 3-minute retry window', limits: {}, retryAfter: '181' },
  ])('FREE-INFLIGHT-DEADLINE: does not retry when Retry-After outlasts $name', async ({ limits, retryAfter }) => {
    config = { ...CONFIG, limits: { ...DEFAULT_FREE_AGENT_LIMITS, ...limits } };
    reply = () => new Response(JSON.stringify({ error: { code: 402, message: 'in-flight budget exhausted',
      metadata: { reason: 'in_flight_budget_exhausted' } } }),
      { status: 402, headers: { 'content-type': 'application/json', 'retry-after': retryAfter } });
    const started = Date.now();
    const response = await call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(402);
    expect((await response.json()).error.metadata.reason).toBe('in_flight_budget_exhausted');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(upstream).toHaveLength(1);
    expect(await freeAgentAllowance(db, OWNER, new Date())).toEqual({ today: 0, lifetime: 0 });
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs(null)).toBe(5_000);
  });
});
