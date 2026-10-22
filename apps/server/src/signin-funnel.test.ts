import { beforeEach, afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import { PgliteDatabase } from './test-support.js';
import { migrate } from './database.js';
import {
  recordSigninFunnelEvent,
  observeFunnelAuth,
  FunnelRateLimit,
  dashboardSigninFunnel,
  compactSigninFunnel,
} from './signin-funnel.js';
let db: PgliteDatabase;
const make = (patch: Partial<SigninFunnelEvent> = {}): SigninFunnelEvent => ({
  event: 'app_opened',
  installId: randomUUID(),
  attemptId: randomUUID(),
  platform: 'android',
  version: '0.2.22',
  environment: 'production',
  timestamp: new Date().toISOString(),
  ...patch,
});
beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
});
afterEach(() => db.close());
const today = () => new Date().toISOString().slice(0, 10);
it('derives anonymous Signup only from an authenticated matching new-account attempt, for either provider', async () => {
  // Upgrade an already-created funnel ledger, rather than only testing a fresh schema.
  await db.query(
    `ALTER TABLE signin_funnel_events DROP CONSTRAINT signin_funnel_events_event_check`,
  );
  await db.query(`ALTER TABLE signin_funnel_events ADD CONSTRAINT signin_funnel_events_event_check
    CHECK (event IN ('app_opened','signin_screen_shown','provider_tapped','callback_result','signed_in'))`);
  await migrate(db);
  for (const provider of ['github', 'google'] as const) {
    const identity = (provider === 'github' ? 'e' : 'f').repeat(64);
    const event = make({ event: 'provider_tapped', provider });
    await recordSigninFunnelEvent(db, event, 'server');
    await db.query(
      `UPDATE signin_funnel_events SET occurred_at=now()-interval '1 minute' WHERE install_id=$1`,
      [event.installId],
    );
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Customer')`, [
      identity,
    ]);
    // A signed-in event without its matching start cannot prove account creation.
    await recordSigninFunnelEvent(
      db,
      { ...event, event: 'signed_in', attemptId: randomUUID() },
      'client',
      identity,
    );
    await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'client');
    expect(
      (
        await db.query(
          `SELECT * FROM signin_funnel_events WHERE event='signup' AND install_id=$1`,
          [event.installId],
        )
      ).rows,
    ).toHaveLength(0);
    await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'client', identity);
    await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'server', identity);
    const completions = (
      await db.query(`SELECT * FROM signin_funnel_events WHERE event='signup' AND install_id=$1`, [
        event.installId,
      ])
    ).rows;
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ source: 'server', provider });
    expect(JSON.stringify(completions)).not.toContain(identity);
  }
  await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '91 days'`);
  await compactSigninFunnel(db);
  const counts = (
    await db.query(
      `SELECT provider,installs FROM signin_funnel_daily WHERE event='signup' ORDER BY provider`,
    )
  ).rows;
  expect(counts.map((r) => ({ provider: r.provider, installs: Number(r.installs) }))).toEqual([
    { provider: 'github', installs: 1 },
    { provider: 'google', installs: 1 },
  ]);
});
it('deduplicates client steps, gives state-bound server callbacks authority, and counts distinct installs', async () => {
  const event = make({ event: 'provider_tapped', provider: 'github' });
  await recordSigninFunnelEvent(db, event);
  await recordSigninFunnelEvent(db, event);
  await observeFunnelAuth(db, {
    phase: 'start',
    flowHash: 'test-flow',
    provider: 'github',
    context: event,
  });
  await recordSigninFunnelEvent(db, {
    ...event,
    event: 'callback_result',
    outcome: 'error',
    errorCode: 'unknown',
  });
  await observeFunnelAuth(db, {
    phase: 'callback',
    flowHash: 'test-flow',
    provider: 'github',
    outcome: 'success',
  });
  await recordSigninFunnelEvent(db, {
    ...event,
    event: 'callback_result',
    outcome: 'error',
    errorCode: 'unknown',
  });
  const rows = (
    await db.query(`SELECT event,outcome,source FROM signin_funnel_events ORDER BY event`)
  ).rows;
  expect(rows).toEqual([
    { event: 'callback_result', outcome: 'success', source: 'server' },
    { event: 'provider_tapped', outcome: '', source: 'server' },
  ]);
  await recordSigninFunnelEvent(db, { ...event, attemptId: randomUUID() });
  const result = await dashboardSigninFunnel(
    db,
    ['android'],
    new Date().toISOString(),
    today(),
    today(),
    10,
  );
  const total = result.perPlatform[0]!;
  expect(total.stages.find((s) => s.stage === 'provider_tapped')?.count).toBe(1);
  expect(result.from).toBe(today());
  expect(total.providers[0]).toMatchObject({
    provider: 'github',
    starts: 1,
    outcomes: [
      { outcome: 'success', count: 1 },
      { outcome: 'cancelled', count: 0 },
      { outcome: 'error', count: 0 },
    ],
  });
  expect(
    total.series.find((s) => s.period === 'weekly' && s.stage === 'provider_tapped')?.count,
  ).toBe(1);
});
it('excludes hidden, fixture and known team installs retroactively at authenticated signed-in', async () => {
  const fixture = 'c2e54c45-cf58-4cc1-a620-89b196096e7b';
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fixture')`, [fixture]);
  for (const [index, hidden, handle, isFixture] of [
    [1, true, 'hidden', false],
    [2, false, 'lunchboxfortwo', false],
    [3, false, 'fixture', true],
  ] as const) {
    const id = String(index).repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle,hidden_from_roster) VALUES($1,'human','Person',$2,$3)`,
      [id, handle, hidden],
    );
    if (isFixture)
      await db.query(
        `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,
        [fixture, id],
      );
    const event = make();
    await recordSigninFunnelEvent(db, event);
    await recordSigninFunnelEvent(
      db,
      { ...event, event: 'signed_in', provider: 'github' },
      'client',
      id,
    );
  }
  const normal = make();
  const customer='4'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Customer without handle')`,[customer]);
  await recordSigninFunnelEvent(db, normal);
  await recordSigninFunnelEvent(db,{...normal,event:'signed_in',provider:'github'},'client',customer);
  const result = await dashboardSigninFunnel(
    db,
    ['android'],
    new Date().toISOString(),
    today(),
    today(),
    10,
  );
  expect(result.perPlatform[0]?.stages[0]?.count).toBe(1);
  expect(
    (await db.query(`SELECT count(*) n FROM signin_funnel_installs WHERE internal`)).rows[0]?.n,
  ).toBe(3);
});
it('drops nonproduction builds, requires authenticated signed-in and filters platform and dates', async () => {
  for (const environment of ['development', 'preview', 'lab', 'review'] as const)
    await recordSigninFunnelEvent(db, make({ environment }));
  await recordSigninFunnelEvent(db, make({ event: 'signed_in', provider: 'github' }));
  expect((await db.query(`SELECT * FROM signin_funnel_events`)).rows).toEqual([]);
  await recordSigninFunnelEvent(db, make());
  await recordSigninFunnelEvent(db, make({ platform: 'web' }));
  let result = await dashboardSigninFunnel(
    db,
    ['web'],
    new Date().toISOString(),
    today(),
    today(),
    null,
  );
  expect(result.perPlatform[0]?.stages[0]?.count).toBe(1);
  result = await dashboardSigninFunnel(
    db,
    ['ios'],
    new Date().toISOString(),
    today(),
    today(),
    null,
  );
  expect(result.perPlatform[0]?.stages[0]?.count).toBe(0);
  result = await dashboardSigninFunnel(
    db,
    ['android'],
    new Date().toISOString(),
    '2026-01-01',
    '2026-01-02',
    null,
  );
  expect(result.state).toBe('not_measured');
  expect(result.perPlatform[0]?.stages[0]?.count).toBeNull();
});
it('compacts expired raw events into anonymous daily counts without retaining install or flow IDs', async () => {
  const event = make();
  await recordSigninFunnelEvent(db, event);
  await recordSigninFunnelEvent(db, { ...event, attemptId: randomUUID() });
  await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '91 days'`);
  await db.query(`UPDATE signin_funnel_installs SET seen_at=now()-interval '91 days'`);
  await compactSigninFunnel(db);
  await compactSigninFunnel(db);
  expect((await db.query(`SELECT * FROM signin_funnel_events`)).rows).toEqual([]);
  expect((await db.query(`SELECT * FROM signin_funnel_installs`)).rows).toEqual([]);
  const rows = (await db.query(`SELECT * FROM signin_funnel_daily`)).rows;
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]?.installs)).toBe(1);
  expect(JSON.stringify(rows)).not.toContain(event.installId);
});
it('rate limits IPs in bounded memory and resets on request without a timer', () => {
  const limit = new FunnelRateLimit();
  for (let i = 0; i < 60; i++) expect(limit.allow('one', 1000)).toBe(true);
  expect(limit.allow('one', 1001)).toBe(false);
  expect(limit.allow('two', 1001)).toBe(true);
  expect(limit.allow('one', 61000)).toBe(true);
});
it('uses the first collection day for every new journey stage and recounts Downloads over those same days',async()=>{
 const event=make();await recordSigninFunnelEvent(db,event);
 const prior=new Date(Date.now()-86400000).toISOString().slice(0,10);
 await db.query(`INSERT INTO store_download_days(platform,day,installs,source,attempted_at,final) VALUES('android',$1,50,'Play',now(),true),('android',$2,10,'Play',now(),true)`,[prior,today()]);
 const result=await dashboardSigninFunnel(db,['android'],new Date().toISOString(),prior,today(),60,{android:60});
 expect(result.from).toBe(today());expect(result.requestedFrom).toBe(prior);
 expect(result.downloads.count).toBe(10);
 expect(result.perPlatform[0]?.stages[0]).toMatchObject({count:1,denominator:10,dropOffCount:9,dropOffRate:0.9});
 expect(result.perPlatform[1]?.stages[0]?.denominator).toBe(10);
});

it('measures authenticated Workspace and first-message stages once per install after migration', async () => {
  const identity = '7'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Customer')`, [identity]);
  const event = make();
  for (const stage of ['workspace_created', 'first_message_sent'] as const) {
    await recordSigninFunnelEvent(db, { ...event, event: stage });
    expect((await db.query(`SELECT * FROM signin_funnel_events WHERE event=$1`, [stage])).rows).toEqual([]);
    await recordSigninFunnelEvent(db, { ...event, event: stage }, 'client', identity);
    await recordSigninFunnelEvent(db, { ...event, event: stage }, 'client', identity);
  }
  const result = await dashboardSigninFunnel(db, ['android'], new Date().toISOString(), today(), today(), null);
  for (const stage of ['workspace_created', 'first_message_sent'])
    expect(result.perPlatform[0]?.stages.find(row => row.stage === stage)).toMatchObject({ count: 1 });
});
