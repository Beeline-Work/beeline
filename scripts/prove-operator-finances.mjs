// Isolated built-HTTP proof. All provider responses are fixtures; no production data or keys.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { OPERATOR_FINANCES_SCHEMA } from '../apps/server/dist/operator-finances.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase();
await db.query(OPERATOR_FINANCES_SCHEMA);
await db.query('CREATE TABLE free_agent_events(at timestamptz,kind text,detail jsonb)');
// R-FINANCES-HISTORY: noon readings cover every date but never close a day.
await db.query(`INSERT INTO operator_finance_snapshots
  SELECT ('2026-09-01'::date + n), 'openrouter', 'server-keys', 'API', 0.50,
    n + 0.50, ('2026-09-01'::date + n)::timestamp AT TIME ZONE 'UTC' + interval '12 hours'
  FROM generate_series(0,29) AS n`);
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
    return Response.json({ data: { total_credits: 15, total_usage: 12 } });
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
  assert.deepEqual(Object.keys(finances).sort(), ['daily','measuredAt','month','services','totals']);
  assert.deepEqual(model.mtd, { value: 12, source: 'api' });
  assert.equal(model.state, 'ready');
  assert.deepEqual(model.lastMonth, { value: null, source: 'unknown' });
  console.log('R-FINANCES-HISTORY: September noon snapshots reaching $29.50 produce unknown lastMonth, never $15/api.');
  assert.deepEqual(model.balance, { value: 3, source: 'api', measuredAt: '2026-10-15T12:00:00.000Z', low: true });
  assert.deepEqual(finances.totals.mtd, { value: null, source: 'unknown' });
  assert.deepEqual(finances.totals.perActiveUser, { value: null, source: 'unknown' });
  const groq = finances.services.find(s => s.id === 'groq');
  assert.deepEqual(groq.mtd, { value: null, source: 'unknown' });
  assert.equal(groq.state, 'unavailable');
  assert.equal(groq.balance, null);
  assert.deepEqual(finances.daily[0].hosting, { value: null, source: 'unknown' });
  assert.ok(!JSON.stringify(body).includes('fixture-private-key'));
  const snapshots = await db.query('SELECT count(*) AS count FROM operator_finance_snapshots');
  assert.ok(Number(snapshots.rows[0].count) > 0);
  await mkdir('docs/fixtures', { recursive: true });
  await writeFile('docs/fixtures/operator-finances.json', JSON.stringify({ finances }) + '\n');
  console.log('FINANCES-A: unauthenticated dashboard hidden; authenticated built HTTP returns sourced spend, low account credit, isolated billing failures, unknown costs and persistent daily snapshots. Fixture saved.');
} finally {
  globalThis.fetch = request;
  Date.now = realNow;
  await new Promise(resolve => server.close(resolve));
  await db.close();
}
