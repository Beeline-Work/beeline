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
  recordOnboardingEvent,
  dashboardOnboarding,
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
it('joins onboarding to the authenticated signup attempt, excludes team accounts, and measures option intervals', async () => {
  for (const [identity, handle] of [['d'.repeat(64), 'customer'], ['e'.repeat(64), 'lunchboxfortwo']]) {
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person',$2)`, [identity, handle]);
    const attempt = make({ event: 'signed_in', provider: 'google' });
    await recordSigninFunnelEvent(db, attempt, 'server', identity);
    await db.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at)
      VALUES($1,$2,'signup','android','0.2.22','server',now())`, [attempt.installId, attempt.attemptId]);
    await recordOnboardingEvent(db, identity!, 'welcome_shown');
    await recordOnboardingEvent(db, identity!, 'option_picked', { option: 'D' });
    await recordOnboardingEvent(db, identity!, 'option_picked', { option: 'B' });
    if (handle === 'customer') {
      await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '2 seconds' WHERE event='welcome_shown'`);
      await recordOnboardingEvent(db, identity!, 'game_posted');
    }
  }
  const dashboard = await dashboardOnboarding(db, ['android'], today(), today());
  const all = dashboard.splits.find(split => split.option === 'all')!;
  expect(all.steps.find(step => step.event === 'welcome_shown')?.count).toBe(1);
  expect(all.steps.find(step => step.event === 'option_picked')?.medianTimeMs).toBeGreaterThanOrEqual(1900);
  expect(dashboard.splits.find(split => split.option === 'D')!.steps.find(step => step.event === 'game_posted')?.count).toBe(1);
  expect(dashboard.splits.find(split => split.option === 'B')!.steps.find(step => step.event === 'game_posted')?.count).toBe(0);
  expect(JSON.stringify(dashboard)).not.toContain('d'.repeat(64));
});
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
  await db.query(`INSERT INTO workspaces(id,name,internal) VALUES($1,'Fixture',true)`, [fixture]);
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
  for (let i = 0; i < 128; i++) expect(limit.allow('one', 1000)).toBe(true);
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

it('keeps first-session screens only for a new signup within 10 minutes, and reads out counts per cohort day', async () => {
  const signup = async (identity: string) => {
    const event = make({ event: 'provider_tapped', provider: 'github' });
    await recordSigninFunnelEvent(db, event, 'server');
    await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '1 minute' WHERE install_id=$1`, [event.installId]);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Customer')`, [identity]);
    await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'client', identity);
    return { ...event, provider: undefined, event: 'screen_shown' as const };
  };
  const a = await signup('a'.repeat(64));
  const b = await signup('b'.repeat(64));
  const screens = async () => (await db.query(`SELECT install_id,screen FROM signin_funnel_events WHERE event='screen_shown' ORDER BY recorded_at`)).rows;
  // Without a session, the server keeps nothing.
  await recordSigninFunnelEvent(db, { ...a, screen: 'beeline/tray' }, 'client');
  expect(await screens()).toEqual([]);
  await recordSigninFunnelEvent(db, { ...a, screen: 'beeline/tray' }, 'client', 'a'.repeat(64));
  await recordSigninFunnelEvent(db, { ...a, screen: 'beeline/tray' }, 'client', 'a'.repeat(64));
  await recordSigninFunnelEvent(db, { ...a, screen: 'beeline/chat/[channelId]' }, 'client', 'a'.repeat(64));
  await recordSigninFunnelEvent(db, { ...b, screen: 'beeline/tray' }, 'client', 'b'.repeat(64));
  // A returning-account sign-in has no Signup row, so its screens are not kept.
  const returning = make({ event: 'screen_shown', screen: 'beeline/tray' });
  await recordSigninFunnelEvent(db, { ...returning, event: 'signed_in', provider: 'github', screen: undefined }, 'client', 'a'.repeat(64));
  await recordSigninFunnelEvent(db, returning, 'client', 'a'.repeat(64));
  expect(await screens()).toHaveLength(3);
  // Ten minutes after that install's signed_in, screen events are dropped.
  await db.query(`UPDATE signin_funnel_events SET occurred_at=occurred_at-interval '10 minutes 1 second' WHERE install_id=$1`, [b.installId]);
  await recordSigninFunnelEvent(db, { ...b, screen: 'beeline/settings' }, 'client', 'b'.repeat(64));
  expect((await screens()).map(r => r.screen)).not.toContain('beeline/settings');
  // Move it back so the readout does not depend on the UTC day boundary.
  await db.query(`UPDATE signin_funnel_events SET occurred_at=occurred_at+interval '10 minutes 1 second' WHERE install_id=$1`, [b.installId]);
  const result = await dashboardSigninFunnel(db, ['android'], new Date().toISOString(), today(), today(), null);
  expect(result.firstSession).toEqual({
    from: expect.any(String),
    through: today(),
    unit: 'people',
    windowMinutes: 10,
    source: expect.any(String),
    days: [{
      date: today(),
      signups: 2,
      withScreens: 2,
      capped: 0,
      screens: [
        { screen: 'beeline/tray', reached: 2, last: 1 },
        { screen: 'beeline/chat/[channelId]', reached: 1, last: 1 },
      ],
    }],
  });
  expect(JSON.stringify(result.firstSession)).not.toContain(a.installId);
  // Screen events stay out of the existing stage counts and series.
  expect(result.perPlatform[0]?.series.some(s => s.stage === 'screen_shown')).toBe(false);
});
it('reads zero screens for signups from builds that send none', async () => {
  const event = make({ event: 'provider_tapped', provider: 'google' });
  await recordSigninFunnelEvent(db, event, 'server');
  await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '1 minute'`);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Customer')`, ['c'.repeat(64)]);
  await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'client', 'c'.repeat(64));
  const result = await dashboardSigninFunnel(db, ['android'], new Date().toISOString(), today(), today(), null);
  expect(result.firstSession.days).toEqual([{ date: today(), signups: 1, withScreens: 0, capped: 0, screens: [] }]);
});
it('upgrades a ledger keyed without screen so each screen gets its own row', async () => {
  await db.query(`ALTER TABLE signin_funnel_events DROP CONSTRAINT signin_funnel_events_pkey`);
  await db.query(`ALTER TABLE signin_funnel_events DROP COLUMN screen`);
  await db.query(`ALTER TABLE signin_funnel_events ADD PRIMARY KEY(install_id,attempt_id,event,provider)`);
  await migrate(db);
  await migrate(db);
  const key = (await db.query(`SELECT pg_get_constraintdef(oid) def FROM pg_constraint
    WHERE conrelid='signin_funnel_events'::regclass AND contype='p'`)).rows[0];
  expect(key?.def).toBe('PRIMARY KEY (install_id, attempt_id, event, provider, screen)');
});

const newSignup = async (identity: string) => {
  const event = make({ event: 'provider_tapped', provider: 'github' });
  await recordSigninFunnelEvent(db, event, 'server');
  await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '1 minute' WHERE install_id=$1`, [event.installId]);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Customer')`, [identity]);
  await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'client', identity);
  let at = Date.now();
  // Each screen event carries a later device time, as the client sends them.
  return (screen: SigninFunnelEvent['screen'], timestamp = new Date((at += 1000)).toISOString()) =>
    recordSigninFunnelEvent(db, { ...event, provider: undefined, event: 'screen_shown', screen, timestamp }, 'client', identity);
};
it('ends A, B, A on A with one stored row per screen and its last-seen time updated', async () => {
  const show = await newSignup('d'.repeat(64));
  await show('beeline/tray');
  const first = (await db.query(`SELECT last_seen_at FROM signin_funnel_events WHERE screen='beeline/tray'`)).rows[0];
  await show('beeline/channels');
  await show('beeline/tray');
  const rows = (await db.query(`SELECT screen,visits,last_seen_at FROM signin_funnel_events WHERE event='screen_shown' ORDER BY screen`)).rows;
  expect(rows.map(r => [r.screen, r.visits])).toEqual([['beeline/channels', 1], ['beeline/tray', 2]]);
  expect(new Date(rows[1].last_seen_at).getTime()).toBeGreaterThan(new Date(first?.last_seen_at ?? 0).getTime());
  const result = await dashboardSigninFunnel(db, ['android'], new Date().toISOString(), today(), today(), null);
  expect(result.firstSession.days[0]).toEqual({
    date: today(), signups: 1, withScreens: 1, capped: 0,
    screens: [
      { screen: 'beeline/channels', reached: 1, last: 0 },
      { screen: 'beeline/tray', reached: 1, last: 1 },
    ],
  });
});
it('counts a person who reaches the send cap as capped, with reach but no last screen', async () => {
  const capped = await newSignup('e'.repeat(64));
  for (let i = 0; i < 70; i++) await capped(i % 2 ? 'beeline/channels' : 'beeline/tray');
  const other = await newSignup('f'.repeat(64));
  await other('beeline/members');
  const stored = (await db.query(`SELECT sum(visits)::int n,count(*)::int rows FROM signin_funnel_events
    WHERE event='screen_shown' AND screen<>'beeline/members'`)).rows[0];
  expect(stored).toEqual({ n: 64, rows: 2 });
  const result = await dashboardSigninFunnel(db, ['android'], new Date().toISOString(), today(), today(), null);
  expect(result.firstSession.days[0]).toEqual({
    date: today(), signups: 2, withScreens: 2, capped: 1,
    screens: [
      { screen: 'beeline/channels', reached: 1, last: 0 },
      { screen: 'beeline/members', reached: 1, last: 1 },
      { screen: 'beeline/tray', reached: 1, last: 0 },
    ],
  });
});
it('orders screens by device time, so a late-arriving earlier screen does not become last', async () => {
  const show = await newSignup('9'.repeat(64));
  const at = Date.now();
  await show('beeline/tray', new Date(at).toISOString());
  // The chat request is delayed and arrives after the final tray visit.
  await show('beeline/tray', new Date(at + 2000).toISOString());
  await show('beeline/chat/[channelId]', new Date(at + 1000).toISOString());
  const result = await dashboardSigninFunnel(db, ['android'], new Date().toISOString(), today(), today(), null);
  expect(result.firstSession.days[0]?.screens).toEqual([
    { screen: 'beeline/chat/[channelId]', reached: 1, last: 0 },
    { screen: 'beeline/tray', reached: 1, last: 1 },
  ]);
});
