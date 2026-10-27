// Built HTTP dashboard proof using recorded aggregate Cloudflare data; no live secrets.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { syncXSiteVisits } from '../apps/server/dist/x-site-visits.js';
import { declareCornerProofOutput } from '../apps/body/dist/corner-proof-output.js';

const db = new PgliteDatabase();
await migrate(db);
const server = createBeelineServer({
  database: db,
  auth: new TokenAuth(db, async subject => ({ subject, login: subject })),
  phone: {}, daemon: {}, live: {}, mediaMaximumBytes: 1,
  dashboardSecret: 'isolated-site-visits-proof',
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const dashboard = async () => {
  const response = await fetch(`${base}/v1/admin/dashboard`, {
    headers: { authorization: 'Bearer isolated-site-visits-proof' },
  });
  assert.equal(response.status, 200);
  return (await response.json()).xAds.siteVisits;
};
try {
  const before = await dashboard();
  assert.equal(before.state, 'unavailable');
  assert.ok(before.daily.every(d => d.siteVisits === null));
  const recorded = JSON.parse(await readFile(new URL('../apps/server/src/x-site-visits.recorded.json', import.meta.url), 'utf8'));
  // Preserve recorded counts/referrers/paths, rebase date for a repeatable recent-window proof.
  const date = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  for (const group of recorded.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups) group.dimensions.date = date;
  await syncXSiteVisits(db, 'fixture', async () => new Response(JSON.stringify(recorded)));
  const after = await dashboard();
  assert.equal(after.state, 'estimated');
  assert.equal(after.daily.find(d => d.date === date).siteVisits, 256);
  await db.query(`UPDATE x_ad_sync SET next_attempt_at=now()-interval '1 minute' WHERE id='site-visits'`);
  await assert.rejects(syncXSiteVisits(db, 'fixture', async () => new Response('{}', { status: 503 })));
  const failed = await dashboard();
  assert.equal(failed.state, 'unavailable');
  assert.ok(failed.daily.every(d => d.siteVisits === null));
  const output = await declareCornerProofOutput(process.cwd(), '49dab7ce-9835-47bb-ac99-66cf19ba8419');
  const result = { feature: 'not a defect report', recordedAt: '2026-10-27T14:01:42Z',
    recordedDate: '2026-10-25', proofDate: date, before, after, failed };
  await writeFile(resolve(output, 'x-site-visits-payload.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: 'PASS', endpoint: '/v1/admin/dashboard',
    recordedSiteVisits: after.daily.find(d => d.date === date),
    initialState: before.state, syncedState: after.state, failedState: failed.state,
    evidence: resolve(output, 'x-site-visits-payload.json') }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await db.close();
}
