// Isolated built-HTTP proof. All provider responses are fixtures; no production data or keys.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { OPERATOR_FINANCES_SCHEMA } from '../apps/server/dist/operator-finances.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase();
await db.query(OPERATOR_FINANCES_SCHEMA);
await db.query('CREATE TABLE free_agent_events(at timestamptz,kind text,detail jsonb)');
const request = globalThis.fetch;
const realNow = Date.now;
Date.now = () => Date.parse('2026-10-15T12:00:00Z');
for (const name of ['BEELINE_FREE_AGENT_MODEL_KEY', 'BEELINE_VOICE_OPENROUTER_API_KEY', 'OPENROUTER_EMBEDDING_API_KEY'])
  process.env[name] = 'fixture-private-key';
for (const name of ['FLY_API_TOKEN', 'FLY_FREE_AGENT_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_WORKERS_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'BEELINE_FREE_AGENT_MODEL_UPSTREAM'])
  delete process.env[name];
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === 'https://openrouter.ai/api/v1/key')
    return Response.json({ data: { usage_monthly: 12, usage_daily: 0.75, limit: 20, limit_remaining: 3 } });
  if (url === 'https://openrouter.ai/api/v1/credits')
    return Response.json({ error: 'fixture-private-key must never be returned' }, { status: 403 });
  throw new Error('External calls disabled in this proof');
};
const server = createBeelineServer({ database: db, dashboardSecret: 'fixture-dashboard-secret',
  auth: { authenticatePhone: async () => null }, phone: {}, daemon: {}, live: {}, mediaMaximumBytes: 1 });
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/admin/dashboard`;
  const unauthorized = await request(url);
  assert.equal(unauthorized.status, 403);
  const response = await request(url, { headers: { Authorization: 'Bearer fixture-dashboard-secret' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  const finances = body.finances;
  const model = finances.services.find(s => s.id === 'openrouter');
  assert.equal(model.spend.monthToDate.usd, 12);
  assert.equal(model.spend.monthToDate.source, 'API');
  assert.equal(model.spend.monthToDate.state, 'partial');
  assert.equal(model.readings[0].state, 'unavailable');
  assert.equal(model.readings[1].low, true);
  assert.equal(finances.summary.monthToDate.usd, null);
  assert.equal(finances.summary.monthToDate.knownUsd, 12);
  assert.equal(finances.snapshotState, 'saved');
  assert.equal(finances.services.find(s => s.id === 'groq').spend.monthToDate.usd, null);
  assert.equal(finances.services.find(s => s.id === 'groq').spend.monthToDate.source, 'unknown');
  assert.equal(typeof finances.services.find(s => s.id === 'groq').error, 'string');
  assert.deepEqual(finances.perUser, { state: 'pending', delivery: 'PR B', activeUsers: null,
    attributedShare: null, attributedUsd: null, unattributedUsd: null, fixedCostPerActiveUserUsd: null, users: [],
    note: 'Per-user attribution follows in PR B' });
  assert.equal(finances.services.find(s => s.id === 'cloudflare').spend.monthToDate.usd, null);
  assert.equal(finances.daily[0].services.find(s => s.serviceId === 'openrouter').usd, null);
  assert.equal(finances.headline.activeUsers, null);
  assert.equal(model.monthToDateUsd, 12);
  assert.equal(model.sources.monthToDateUsd, 'api');
  assert.equal(model.category, 'models');
  assert.equal(model.billingType, 'credits');
  assert.equal(finances.daily[0].hosting, null);
  assert.ok(!JSON.stringify(body).includes('fixture-private-key'));
  const snapshots = await db.query('SELECT count(*) AS count FROM operator_finance_snapshots');
  assert.ok(Number(snapshots.rows[0].count) > 0);
  await mkdir('docs/fixtures', { recursive: true });
  await writeFile('docs/fixtures/operator-finances.json', JSON.stringify({ finances }) + '\n');
  console.log('FINANCES-A: unauthenticated dashboard hidden; authenticated built HTTP returns sourced spend, low allowance, isolated billing failures, unknown costs and persistent daily snapshots. Fixture saved.');
} finally {
  globalThis.fetch = request;
  Date.now = realNow;
  await new Promise(resolve => server.close(resolve));
  await db.close();
}
