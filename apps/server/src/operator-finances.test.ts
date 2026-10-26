import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { createOperatorFinances, OPERATOR_FINANCES_SCHEMA } from './operator-finances.js';
import { createDashboardServices } from './operator-dashboard-services.js';
import { financesWire } from './operator-finances-wire.js';
import { readFile } from 'node:fs/promises';

const databases: PgliteDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });
async function database() {
  const db = new PgliteDatabase(); databases.push(db);
  await db.query(OPERATOR_FINANCES_SCHEMA);
  await db.query('CREATE TABLE free_agent_events(at timestamptz, kind text, detail jsonb)');
  return db;
}
const timestamp = Date.parse('2026-10-15T12:00:00Z');
const env = {
  BEELINE_FREE_AGENT_MODEL_KEY: 'private-key-not-for-the-ui',
  BEELINE_VOICE_OPENROUTER_API_KEY: 'private-key-not-for-the-ui',
  OPENROUTER_EMBEDDING_API_KEY: 'different-private-key',
  CLOUDFLARE_API_TOKEN: 'private-cloudflare-key', CLOUDFLARE_ACCOUNT_ID: 'test-account',
  FLY_API_TOKEN: 'private-fly-token',
};
function providers() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/key')) return Response.json({ data: { usage_monthly: 14.5, usage_daily: 1,
      limit: null, limit_remaining: null, label: 'secret-key-prefix-never-project' } });
    if (url.endsWith('/credits')) return Response.json({ error: 'private-provider-body' }, { status: 403 });
    if (url.includes('billable-usage')) return Response.json({ success: true, result: [
      { BillingCurrency: 'USD', ChargePeriodStart: '2026-10-14T00:00:00Z',
        ChargePeriodEnd: '2026-10-14T23:59:59Z', ContractedCost: 4 },
      { BillingCurrency: 'USD', ChargePeriodStart: '2026-10-15T00:00:00Z',
        ChargePeriodEnd: '2026-10-15T11:59:59Z', ContractedCost: 2 },
      { BillingCurrency: 'USD', ChargePeriodStart: '2026-09-01T00:00:00Z',
        ChargePeriodEnd: '2026-09-30T23:59:59Z', ContractedCost: 20 },
    ] });
    if (url.includes('fly.io')) return Response.json({ data: { app: { organization: { creditBalance: 1234 } } } });
    throw new Error('Unexpected external request');
  });
}

describe('operator finances', () => {
  it('emits exactly the dashboard PR 13 wire shape with nullable sourced money', async () => {
    const db = await database();
    const result = financesWire(await createOperatorFinances(db, env, providers(), () => timestamp)());
    const fixture = JSON.parse(await readFile(new URL('./operator-finances-contract.fixture.json', import.meta.url), 'utf8')).finances;
    expect(Object.keys(result).sort()).toEqual(Object.keys(fixture).sort());
    expect(Object.keys(result.totals).sort()).toEqual(Object.keys(fixture.totals).sort());
    expect(Object.keys(result.services[0]!).sort()).toEqual(Object.keys(fixture.services[0]).sort());
    expect(Object.keys(result.daily[0]!).sort()).toEqual(Object.keys(fixture.daily[0]).sort());
    expect(result.services.find(s => s.id === 'openrouter')!.mtd).toEqual({ value: 29, source: 'api' });
    expect(result.totals.mtd).toEqual({ value: null, source: 'unknown' });
    expect(result.totals.perActiveUser).toEqual({ value: null, source: 'unknown' });
    expect(result.daily[0]!.models).toEqual({ value: null, source: 'unknown' });
    expect(result.services.find(s => s.id === 'groq')!.state).toBe('unavailable');
    expect(result.services.find(s => s.id === 'groq')!.balance).toBeNull();
  });
  it('projects sourced spend, deduplicates keys and stores daily readings without counting monthly charges as a day', async () => {
    const db = await database(), fetcher = providers();
    const result = await createOperatorFinances(db, env, fetcher, () => timestamp)();
    const openrouter = result.services.find(s => s.id === 'openrouter')!;
    expect(openrouter.spend.monthToDate).toMatchObject({ usd: 29, source: 'API', state: 'partial' });
    expect(openrouter.spend.projectedMonth.usd).toBeCloseTo(62);
    expect(result.services.find(s => s.id === 'cloudflare')!.spend).toMatchObject({
      monthToDate: { usd: 6, source: 'API' }, lastMonth: { usd: 20, state: 'partial' },
    });
    expect(result.snapshotState).toBe('saved');
    expect((await db.query('SELECT * FROM operator_finance_snapshots WHERE service_id=$1', ['cloudflare'])).rows).toHaveLength(2);
    expect(result.daily.find(d => d.date === '2026-09-01')!.services.find(s => s.serviceId === 'cloudflare')!.usd).toBeNull();
    expect(result.summary.monthToDate.usd).toBeNull();
    expect(result.summary.monthToDate.knownUsd).toBe(35);
    const fly = result.services.find(s => s.id === 'fly')!;
    expect(fly.readings[0]).toMatchObject({ value: 12.34, low: null });
    expect(openrouter.readings[1]).toMatchObject({ state: 'measured', value: null, low: null });
    const serialized = JSON.stringify(result);
    for (const value of Object.values(env)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('secret-key-prefix');
    expect(serialized).not.toContain('private-provider-body');
  });

  it('R-FINANCES-HISTORY rejects September noon snapshots as completed last-month coverage', async () => {
    const db = await database();
    await db.query(`INSERT INTO operator_finance_snapshots
      SELECT ('2026-09-01'::date + n), 'openrouter', 'server-keys', 'API', 0.50,
        n + 0.50, ('2026-09-01'::date + n)::timestamp AT TIME ZONE 'UTC' + interval '12 hours'
      FROM generate_series(0,29) AS n`);
    const result = await createOperatorFinances(db, env, providers(), () => timestamp)();
    expect(result.services.find(s => s.id === 'openrouter')!.spend.lastMonth)
      .toMatchObject({ usd: null, source: 'unknown', state: 'unknown' });
    expect(financesWire(result).services.find(s => s.id === 'openrouter')!.lastMonth)
      .toEqual({ value: null, source: 'unknown' });
  });

  it('coalesces simultaneous refreshes and caches provider failures for ten minutes', async () => {
    const db = await database(), fetcher = providers(); let time = timestamp;
    const read = createOperatorFinances(db, env, fetcher, () => time);
    const [first, second] = await Promise.all([read(), read()]);
    expect(second).toBe(first);
    const calls = fetcher.mock.calls.length;
    time += 599999; await read(); expect(fetcher).toHaveBeenCalledTimes(calls);
    time += 2; await read(); expect(fetcher.mock.calls.length).toBeGreaterThan(calls);
  });

  it('retains timestamped snapshots after restart and provider failure without implying a current projection', async () => {
    const db = await database();
    await createOperatorFinances(db, env, providers(), () => timestamp)();
    const failure = vi.fn<typeof fetch>(async () => { throw new Error('private-key-not-for-the-ui'); });
    const result = await createOperatorFinances(db, env, failure, () => timestamp + 86400000)();
    expect(result.services.find(s => s.id === 'openrouter')!.spend).toMatchObject({
      monthToDate: { state: 'stale', usd: 29 }, projectedMonth: { usd: null },
    });
    expect(result.services.find(s => s.id === 'cloudflare')!.spend.monthToDate).toMatchObject({ state: 'stale', usd: 6 });
    expect(JSON.stringify(result)).not.toContain('private-key-not-for-the-ui');
    expect(result.daily.find(d => d.date === '2026-10-15')!.services.find(s => s.serviceId === 'cloudflare')!.usd).toBe(2);
  });

  it('uses settled model event estimates as a subset fallback and never adds them to the API amount', async () => {
    const db = await database();
    await db.query("INSERT INTO free_agent_events VALUES('2026-10-10','model_usage','{\"usd\":2}'),('2026-10-10','model_usage','{\"usd\":\"invalid\"}')");
    const result = await createOperatorFinances(db, {}, providers(), () => timestamp)();
    expect(result.services.find(s => s.id === 'openrouter')!.spend.monthToDate).toMatchObject({ usd: 2, source: 'metered', state: 'partial' });
    const api = await createOperatorFinances(db, env, providers(), () => timestamp + 1)();
    expect(api.services.find(s => s.id === 'openrouter')!.spend.monthToDate.usd).toBe(29);
    expect(api.daily.find(d => d.date === '2026-10-15')!.services.find(s => s.serviceId === 'openrouter')!.usd).toBe(2);
  });

  it('keeps unentered invoices unknown and allocates verified fixed costs across leap-year months', async () => {
    const db = await database();
    const result = await createOperatorFinances(db, {}, providers(), () => Date.parse('2024-02-15T12:00:00Z'), [
      { serviceId: 'expo', monthlyUsd: 29, effectiveFrom: '2024-01-01', effectiveThrough: null, note: 'Verified invoice' },
    ])();
    const expo = result.services.find(s => s.id === 'expo')!;
    expect(expo.spend.monthToDate).toMatchObject({ usd: 14.5, source: 'entered' });
    expect(expo.spend.projectedMonth.usd).toBeCloseTo(29);
    expect(expo.spend.lastMonth.usd).toBeCloseTo(29);
    expect(result.services.find(s => s.id === 'sentry')!.spend.monthToDate.usd).toBeNull();
    expect(result.daily.find(d => d.date === '2024-02-15')!.services.find(s => s.serviceId === 'expo')!.usd).toBe(1);
  });

  it('isolates malformed provider data from other rows and never turns null credit into zero', async () => {
    const good = providers();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => String(input).includes('openrouter')
      ? Response.json({ data: { total_credits: null, total_usage: 1, limit_remaining: '5' } }) : good(input, init));
    const result = await createDashboardServices(env, fetcher, () => timestamp)();
    expect(result.services.find(s => s.id === 'openrouter')!.readings.every(r => r.value === null)).toBe(true);
    expect(result.services.find(s => s.id === 'fly')!.readings[0]!.value).toBe(12.34);
  });
});
