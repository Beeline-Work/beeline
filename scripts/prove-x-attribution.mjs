// Isolated proof of the built HTTP signup and private-dashboard paths. No live credentials.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { deliverXSignups } from '../apps/server/dist/x-ads.js';
import { syncXAdReports } from '../apps/server/dist/x-ad-reports.js';

const output = new URL('../.scratch/x-ads/', import.meta.url);
await mkdir(output, { recursive: true });
const db = new PgliteDatabase();
await migrate(db);
const auth = new TokenAuth(db, async (subject) => ({
  subject,
  login: subject,
  name: 'Fixture person',
}));
const server = createBeelineServer({
  database: db,
  auth,
  phone: {},
  daemon: {},
  live: {},
  mediaMaximumBytes: 1,
  dashboardSecret: 'isolated-proof',
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const context = {
    twclid: 'fixture-click',
    campaignId: 'campaign',
    adId: 'clip',
    adGroupId: 'audience',
    capturedAt: Date.now(),
  };
  const signup = async (subject, click = context) => {
    const response = await fetch(`${base}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: subject, xAttribution: click }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await signup('new-person');
  assert.ok(first.xSignup);
  assert.equal((await signup('new-person')).xSignup, undefined);
  assert.equal(
    (await signup('new-person', { ...context, twclid: 'other-device' })).xSignup,
    undefined,
  );
  await signup('organic', null);
  await signup('organic');
  const conversions = [];
  const provider = async (_url, request) => {
    conversions.push(JSON.parse(request.body));
    return new Response(JSON.stringify({ data: { conversions_processed: 1 } }));
  };
  assert.equal(await deliverXSignups(db, 'isolated-fixture', provider), 1);
  assert.equal(await deliverXSignups(db, 'isolated-fixture', provider), 0);
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].conversions[0].conversion_id, first.xSignup.conversionId);
  assert.equal((await db.query('SELECT count(*)::int count FROM x_ad_signups')).rows[0].count, 1);
  await db.query(
    `UPDATE x_ad_signups SET created_at=date_trunc('day',now() AT TIME ZONE 'UTC')-interval '1 day'+interval '1 hour'`,
  );
  const get = async (path, query) => {
    if (path === 'accounts/fixture') return { data: { currency: 'USD' } };
    if (path.endsWith('/campaigns')) return { data: [{ id: 'campaign', name: 'Beeline launch' }] };
    if (path.endsWith('/line_items'))
      return { data: [{ id: 'audience', name: 'Fixture audience', campaign_id: 'campaign' }] };
    if (path.endsWith('/promoted_tweets'))
      return { data: [{ id: 'clip', tweet_id: 'Fixture clip', line_item_id: 'audience' }] };
    const values = (n) =>
      Array.from({ length: 168 }, (_, i) =>
        i === 145 && query.placement === 'ALL_ON_TWITTER' ? n : 0,
      );
    return {
      data: [
        {
          id: query.entity_ids,
          id_data: [
            {
              segment: null,
              metrics: {
                impressions: values(1000),
                url_clicks: values(20),
                billed_charge_local_micro: values(10_000_000),
              },
            },
          ],
        },
      ],
    };
  };
  await syncXAdReports(db, get, 'fixture');
  const response = await fetch(`${base}/v1/admin/dashboard`, {
    headers: { authorization: 'Bearer isolated-proof' },
  });
  assert.equal(response.status, 200);
  const { xAds } = await response.json();
  for (const level of ['campaign', 'ad_group', 'ad']) {
    const row = xAds.rows.find((r) => r.level === level && r.impressions === 1000);
    assert.equal(row.signups, 1);
    assert.equal(row.costPerClick, 0.5);
    assert.equal(row.costPerSignup, 10);
  }
  assert.equal(xAds.coverage.unattributedShare, 0.5);
  const proof = {
    feature: 'not a defect report',
    target: 'built loopback HTTP service with isolated PGlite and X provider fixtures',
    result: 'PASS',
    newAccountRows: 1,
    conversionRequests: conversions.length,
    returningSigninsAttributed: 0,
    xAds,
  };
  await writeFile(new URL('service-proof.json', output), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    'PASS: landing context → built signup HTTP API → one account row and one X conversion → private dashboard daily campaign/clip/audience rows.',
  );
  console.log('Live X analytics and frontend UI are not exercised by this fixture proof.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
}
