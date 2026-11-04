import { readOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { DEFAULT_FREE_AGENT_LIMITS } from './free-agent-limits.js';
import { freeAgentModelTakesImages } from './free-agent-image-input.js';
import { handleFreeAgentModelRequest, type FreeAgentModelProxyOptions } from './free-agent-model-proxy.js';
import { MODEL, MODEL_AGENT, MODEL_ROOM, ownedModelFixture } from './test-fixtures/owned-model.js';

vi.mock('./free-agent-image-input.js', async original => ({
  ...await original<typeof import('./free-agent-image-input.js')>(), freeAgentModelTakesImages: vi.fn(async () => false),
}));
const ONE = '11111111-1111-4111-8111-111111111111', TWO = '22222222-2222-4222-8222-222222222222';
const input = { messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_HISTORY' }], max_tokens: 8 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const success = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'SYNTHETIC_PRIVATE_ANSWER' } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00002 } });

describe('actual owned model endpoint and actual quota adapter', () => {
  let f: Awaited<ReturnType<typeof ownedModelFixture>>, server: Server, origin: string, options: FreeAgentModelProxyOptions;
  let calls: { body: string; headers: Headers }[], reply: () => Response | Promise<Response>;
  beforeEach(async () => {
    vi.mocked(freeAgentModelTakesImages).mockClear(); f = await ownedModelFixture(); calls = []; reply = success;
    options = { database: f.db, config: { model: 'unselected/default', dailyTokenCap: 100_000, firstDayTokenCap: 100_000, lifetimeTokenCap: 0 },
      upstreamKey: 'SYNTHETIC_SERVER_PROVIDER_KEY',
      ownedModel: { credentials: f.credentials, ready: () => true },
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ body: String(init?.body), headers: new Headers(init?.headers) }); return Promise.resolve(reply());
      }) as typeof fetch,
    };
    server = createServer((request, response) => {
      void handleFreeAgentModelRequest(request, response, new URL(request.url!, 'http://fixture').pathname, options).catch(() => response.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { vi.useRealTimers(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.db.close(); });
  const call = (body: Record<string, unknown> = input, id = ONE, token?: string) => fetch(origin + '/v1/free-agents/model/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${token ?? f.issued.token}`, 'x-beeline-model-request': id,
      'content-type': 'application/json', 'x-beeline-command-generation': 'UNTRUSTED_CALLER_METADATA' }, body: JSON.stringify(body),
  });
  const counters = async () => ({
    usage: (await f.db.query('SELECT tokens,reservation_credit FROM free_agent_usage')).rows,
    budget: (await f.db.query('SELECT usd FROM free_agent_budget')).rows,
    rate: (await f.db.query('SELECT calls FROM free_agent_call_rate')).rows,
  });

  it('pins actual command model, strips private identity headers, settles real quota once and replays outcome only', async () => {
    const first = await call({ ...input, model: 'attacker/model', models: ['attacker/fallback'], n: 5, provider: { order: ['attacker'] } });
    expect(first.status).toBe(200); expect(await first.text()).toContain('SYNTHETIC_PRIVATE_ANSWER'); expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({ ...input, model: MODEL, usage: { include: true } });
    expect([...calls[0]!.headers.keys()].sort()).toEqual(['authorization', 'content-type', 'http-referer', 'x-title']);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer SYNTHETIC_SERVER_PROVIDER_KEY');
    expect(calls[0]!.body).not.toContain(f.issued.token); expect(freeAgentModelTakesImages).not.toHaveBeenCalled();
    expect((await counters()).usage.map(row => Number(row.tokens))).toEqual([13]);
    expect(Number((await counters()).budget[0]?.usd)).toBeCloseTo(0.00002);
    expect((await f.db.query(`SELECT kind FROM free_agent_events WHERE kind='model_usage'`)).rowCount).toBe(1);
    const before = await counters(), replay = await call(); expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ receipt: { requestId: ONE, state: 'succeeded', evidence: { kind: 'usage', tokens: 13 } } });
    expect(calls).toHaveLength(1); expect(await counters()).toEqual(before);
    const stored = JSON.stringify((await f.db.query('SELECT * FROM owned_model_attempts')).rows);
    for (const secret of ['SYNTHETIC_PRIVATE_HISTORY', 'SYNTHETIC_PRIVATE_ANSWER', 'SYNTHETIC_SERVER_PROVIDER_KEY', f.issued.token]) expect(stored).not.toContain(secret);
  });

  it('retains actual allowance on lost transport and refuses same-ID and new-UUID retries without duplicate accounting', async () => {
    reply = () => Promise.reject(new Error('SYNTHETIC_PRIVATE_PROVIDER_FAILURE'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const first = await call(); expect(first.status).toBe(409); expect(await first.json()).toMatchObject({ error: { code: 'owned_model_unknown' } });
    const before = await counters(); expect(Number(before.usage[0]?.tokens)).toBeGreaterThan(0);
    const replay = await call(); expect(await replay.json()).toMatchObject({ receipt: { state: 'unknown' } });
    const changedId = await call(input, TWO); expect(await changedId.json()).toMatchObject({ error: { code: 'owned_model_unknown' } });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); vi.useRealTimers();
    expect(calls).toHaveLength(1); expect(await counters()).toEqual(before);
  });

  it.each([402, 429, 500])('makes one actual upstream attempt for HTTP%s without Retry-After resubmission', async status => {
    reply = () => Response.json({ error: { metadata: { reason: 'in_flight_budget_exhausted' } } }, { status, headers: { 'retry-after': '1' } });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const first = await call(); expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ receipt: { state: status === 500 ? 'unknown' : 'refused' } });
    if (status === 500) expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(0);
    else expect(Number((await counters()).usage[0]?.tokens)).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); vi.useRealTimers(); expect(calls).toHaveLength(1);
  });

  it('uses the actual fetch transport once on a transient response and once on a lost response, without timer redispatch', async () => {
    let requests = 0, drop = false; const forwarded: { url: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
    const upstream = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += String(chunk); }); request.on('end', () => {
        requests++; forwarded.push({ url: request.url, headers: request.headers, body });
        if (drop) { response.destroy(); return; }
        response.writeHead(402, { 'content-type': 'application/json', 'retry-after': '1' });
        response.end(JSON.stringify({ error: { metadata: { reason: 'in_flight_budget_exhausted' } } }));
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    options.fetchImpl = undefined; options.upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const refused = await call(); expect(await refused.json()).toMatchObject({ receipt: { state: 'refused' } }); expect(requests).toBe(1);
      expect(forwarded[0]?.url).toBe('/v1/chat/completions'); expect(forwarded[0]?.headers.authorization).toBe('Bearer SYNTHETIC_SERVER_PROVIDER_KEY');
      expect(forwarded[0]?.headers['x-beeline-model-request']).toBeUndefined(); expect(forwarded[0]?.body).not.toContain(f.issued.token);
      drop = true; const unknown = await call(input, TWO); expect(await unknown.json()).toMatchObject({ receipt: { state: 'unknown' } });
      expect(requests).toBe(2); expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); vi.useRealTimers(); expect(requests).toBe(2);
      const replay = await call(input, TWO); expect(await replay.json()).toMatchObject({ receipt: { state: 'unknown' } }); expect(requests).toBe(2);
    } finally { vi.useRealTimers(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  });

  it('keeps a partial stream UNKNOWN with the original reservation even when usage arrives before the lost terminal delimiter', async () => {
    let next = 0; const encoder = new TextEncoder();
    reply = () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!next++) controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.00001}}\n\n'));
      else controller.error(new Error('synthetic partial stream loss'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const wire = { ...input, stream: true };
    await call(wire).then(response => response.text()).catch(() => {});
    expect((await f.db.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([
      { state: 'unknown', evidence: null },
    ]);
    expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(5);
    expect((await f.db.query(`SELECT kind FROM free_agent_events WHERE kind='model_usage'`)).rowCount).toBe(0);
    const before = await counters(); const replay = await call(wire); expect(await replay.json()).toMatchObject({ receipt: { state: 'unknown' } });
    expect(await counters()).toEqual(before); expect(calls).toHaveLength(1);
  });

  it('keeps the conservative reservation when a complete answer has no valid usage', async () => {
    reply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'synthetic answer without billing evidence' } }] });
    await call().then(response=>response.text()).catch(()=>{});
    expect((await f.db.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown', evidence: null }]);
    expect(Number((await counters()).usage[0]?.tokens)).toBeGreaterThan(0);
    expect((await f.db.query(`SELECT kind FROM free_agent_events WHERE kind='model_usage'`)).rowCount).toBe(0);
  });

  it('withholds SDK terminal evidence until the actual settlement transaction commits and strips every upstream ID', async () => {
    const entered=deferred<void>(), release=deferred<void>();
    options.database={query:(sql,args)=>f.db.query(sql,args),transaction:work=>f.db.transaction(tx=>work({
      transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{
        const result=await tx.query(sql,args);
        if(sql.includes('UPDATE owned_model_attempts SET')){entered.resolve();await release.promise;}
        return result;
      },
    }))};
    reply=()=>new Response('data: {"id":"forged-first","choices":[{"delta":{"content":"synthetic"},"finish_reason":null}]}\n\n'+
      'data: {"id":"forged-last","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"cost":0.00002}}\n\n'+
      'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    const response=await call({...input,stream:true}),reader=response.body!.getReader();
    try{
      const first=await reader.read();const before=new TextDecoder().decode(first.value);await entered.promise;
      expect(before).not.toContain('forged');expect(before).not.toContain('bfmr_');expect(before).not.toContain('[DONE]');
      release.resolve();let tail='';for(;;){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}
      const frames=tail.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
      const receipt=frames.find(frame=>frame.id)?.id;
      expect(readOwnedModelReceipt(receipt,f.issued.token,ONE)).toMatchObject({requestId:ONE,state:'succeeded',evidence:{kind:'usage',tokens:13}});
      expect(readOwnedModelReceipt(receipt,f.issued.token,TWO)).toBeNull();expect(tail).toContain('[DONE]');
    }finally{release.resolve();reader.releaseLock();}
  });

  it.each(['missing-done','settlement-failure'])('emits no terminal receipt for %s even after a provider finish',async mode=>{
    if(mode==='settlement-failure')options.database={query:(sql,args)=>f.db.query(sql,args),transaction:work=>f.db.transaction(tx=>work({
      transaction:nested=>tx.transaction(nested),query:(sql,args)=>sql.includes('UPDATE owned_model_attempts SET')?
        Promise.reject(new Error('synthetic settlement rollback')):tx.query(sql,args),
    }))};
    reply=()=>new Response('data: {"id":"forged","choices":[{"delta":{"content":"synthetic"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"cost":0.00002}}\n\n'+
      (mode==='missing-done'?'':'data: [DONE]\n\n'),{headers:{'content-type':'text/event-stream'}});
    let observed='';await call({...input,stream:true}).then(async response=>{const reader=response.body!.getReader();
      try{for(;;){const next=await reader.read();if(next.done)break;observed+=new TextDecoder().decode(next.value);}}finally{reader.releaseLock();}
    }).catch(()=>{});
    expect(observed).not.toContain('bfmr_');expect(observed).not.toContain('[DONE]');expect(observed).not.toContain('forged');
    expect((await f.db.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([{state:'unknown',evidence:null}]);
    expect(calls).toHaveLength(1);
  });

  it('keeps the selected text-only cohort explicit without image metadata reads or quota admission', async () => {
    const image = await call({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://synthetic.invalid/image.png' } }] }] });
    expect(image.status).toBe(400); await image.text(); expect(calls).toHaveLength(0);
    expect(freeAgentModelTakesImages).not.toHaveBeenCalled(); expect(await counters()).toEqual({ usage: [], budget: [], rate: [] });
  });

  it('rolls actual token/budget/rate reservation back when the attempt insert cannot commit', async () => {
    const wrap = (tx: SqlDatabase): SqlDatabase => ({ transaction: work => tx.transaction(inner => work(wrap(inner))), query: (sql, values) => {
      if (sql.includes('INSERT INTO owned_model_attempts(')) return Promise.reject(new Error('synthetic attempt insert failure'));
      return tx.query(sql, values);
    } });
    options.database = { query: (sql, values) => f.db.query(sql, values), transaction: work => f.db.transaction(tx => work(wrap(tx))) };
    const response = await call(); expect(response.status).toBe(503); await response.text(); expect(calls).toHaveLength(0);
    expect(await counters()).toEqual({ usage: [], budget: [], rate: [] });
    expect((await f.db.query('SELECT * FROM owned_model_attempts')).rowCount).toBe(0);
  });

  it('refunds only the queued known nonentry after real membership revocation, with no second provider call', async () => {
    const firstEntered = deferred<void>(), provider = deferred<Response>(), secondCommitted = deferred<void>();
    options.config = { ...options.config, limits: { ...DEFAULT_FREE_AGENT_LIMITS, maxConcurrentCalls: 1 } };
    options.database = { query: (sql, values) => f.db.query(sql, values), transaction: work => f.db.transaction(async tx => {
      let second = false;
      const result = await work({ transaction: nested => tx.transaction(nested), query: (sql, values) => {
        if (sql.includes('INSERT INTO owned_model_attempts(') && values?.[1] === TWO) second = true; return tx.query(sql, values);
      } }); return { result, second };
    }).then(({ result, second }) => { if (second) secondCommitted.resolve(); return result; }) };
    reply = () => { firstEntered.resolve(); return provider.promise; };
    const first = call().then(async response => { await response.text(); }); await firstEntered.promise;
    const second = call({ ...input, messages: [{ role: 'user', content: 'another synthetic tool result' }] }, TWO);
    await secondCommitted.promise;
    await f.db.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1', [MODEL_ROOM]);
    provider.resolve(success()); await first;
    const refused = await second; expect(await refused.json()).toMatchObject({ receipt: { requestId: TWO, state: 'refused', evidence: { kind: 'not-dispatched' } } });
    expect(calls).toHaveLength(1); expect(Number((await counters()).usage[0]?.tokens)).toBe(13);
  });

  it('refuses default-off and every malformed owned namespace before legacy lookup or model metadata work', async () => {
    const queries: string[] = [], base = options.database;
    options.database = { query: (sql, values) => { queries.push(sql); return base.query(sql, values); }, transaction: work => base.transaction(work) };
    options.ownedModel = { credentials: f.credentials, ready: () => false };
    const disabled = await call(); expect(disabled.status).toBe(401); await disabled.text(); expect(queries).toEqual([]);
    options.ownedModel = { credentials: f.credentials, ready: () => true };
    for (const token of ['bfmc_v1.invalid', f.issued.token.replace('bfmc_v1.', 'bfmc_v2.'), 'bfmc_bfm_legacy']) {
      const invalid = await call(input, ONE, token); expect(invalid.status).toBe(401); await invalid.text();
    }
    expect(queries).toEqual([]); expect(calls).toHaveLength(0); expect(freeAgentModelTakesImages).not.toHaveBeenCalled();
  });

  it('rechecks current token rotation after authentication before quota or provider work', async () => {
    const authenticated = deferred<void>(), release = deferred<void>(); let pause = true;
    options.database = { transaction: work => f.db.transaction(work), query: async (sql, values) => {
      const result = await f.db.query(sql, values);
      if (pause && sql.startsWith('SELECT command.agent_id')) { pause = false; authenticated.resolve(); await release.promise; }
      return result;
    } };
    const pending = call(); await authenticated.promise;
    await f.db.query('UPDATE free_agents SET model_token_hash=$2 WHERE agent_id=$1', [MODEL_AGENT, 'd'.repeat(64)]);
    release.resolve(); const response = await pending; expect(response.status).toBe(403); await response.text();
    expect(calls).toHaveLength(0); expect(await counters()).toEqual({ usage: [], budget: [], rate: [] });
    expect(freeAgentModelTakesImages).not.toHaveBeenCalled();
  });
});
