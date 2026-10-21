import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { recordSigninFunnelEvent } from './signin-funnel.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createBeelineServer } from './server.js';
import { dashboardHealth, dashboardOps } from './operator-dashboard.js';
import { dashboardOverview } from './operator-dashboard-overview.js';
import { REVIEW_IDENTITY_ID } from './review-access.js';
import { QueryWindow } from './query-profile.js';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import type { LiveHub } from './live.js';

const workspace = '10000000-0000-4000-8000-000000000801';
const room = '20000000-0000-4000-8000-000000000801';
const secret = 'a private message that must never leave the database';
let db: PgliteDatabase;
let server: ReturnType<typeof createBeelineServer>;
let base: string;

beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Dashboard test')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Main')`, [room, workspace]);
  server = createBeelineServer({
    database: db,
    dashboardSecret: 'dashboard-only-secret',
    auth: {
      authenticatePhone: async (value: string) =>
        value === 'phone-key-for-dashboard-test' ? 'viewer' : null,
    } as TokenAuth,
    phone: {} as PhoneService,
    daemon: {} as DaemonService,
    live: {} as LiveHub,
    mediaMaximumBytes: 1,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  vi.unstubAllEnvs();
});

function get(query = '', key = 'dashboard-only-secret') {
  return fetch(`${base}/v1/admin/dashboard${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}
async function seed() {
  for (let index = 1; index <= 12; index++) {
    const human = `a${index.toString(16).padStart(63, '0')}`;
    const agent = `b${index.toString(16).padStart(63, '0')}`;
    const platform = index <= 6 ? 'ios' : 'android';
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Person'),($2,'agent','Agent')`,
      [human, agent],
    );
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member'),($1,$3,'member')`,
      [workspace, human, agent],
    );
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [
      index.toString(16).padStart(64, '0'),
      agent,
    ]);
    await db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,$3,'physical')`,
      [`push-${index}`, human, platform],
    );
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      `message-${index}`,
      room,
      agent,
      secret,
    ]);
    await db.query(
      `INSERT INTO device_update_receipts(identity_id,device_id,receipt) VALUES($1,$2,$3::jsonb)`,
      [
        human,
        `device-${index}`,
        JSON.stringify({
          platform,
          releaseVersion: index <= 6 ? 'v2' : 'v1',
          runtimeVersion: '30',
        }),
      ],
    );
  }
}

describe('private operator dashboard', () => {
  it('keeps the Google exchange authoritative for anonymous Signup after integrating Google sign-in', async () => {
    const identity = 'e'.repeat(64);
    const event = {
      event: 'provider_tapped' as const, installId: randomUUID(), attemptId: randomUUID(),
      platform: 'android' as const, provider: 'google' as const, version: '0.2.22',
      environment: 'production' as const, timestamp: new Date().toISOString(),
    };
    await recordSigninFunnelEvent(db, event, 'server');
    const exchange = createBeelineServer({
      database: db,
      auth: { exchangeGoogleOidc: async () => {
        await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Google customer')`, [identity]);
        return {identityId: identity};
      } } as TokenAuth,
      phone: {} as PhoneService, daemon: {} as DaemonService, live: {} as LiveHub,
      mediaMaximumBytes: 1,
    });
    await new Promise<void>(resolve => exchange.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(exchange.address() as AddressInfo).port}/v1/auth/google/exchange`, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({oidcToken: 'test-proof', funnel: event}),
      });
      expect(response.status).toBe(200);
      const rows = (await db.query(`SELECT event,source,provider FROM signin_funnel_events WHERE event<>'provider_tapped' ORDER BY event`)).rows;
      expect(rows).toEqual([
        {event:'signed_in',source:'server',provider:'google'},
        {event:'signup',source:'server',provider:'google'},
      ]);
      expect(JSON.stringify(rows)).not.toContain(identity);
      expect(JSON.stringify(rows)).not.toContain('test-proof');
    } finally {
      await new Promise<void>(resolve => exchange.close(() => resolve()));
    }
  });
  it('R-signup-installs: shows install-based Signup drop-off through HTTP without counting returning accounts', async () => {
    const customer = 'c'.repeat(64),
      returning = 'd'.repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name,created_at) VALUES
      ($1,'human','New customer',(now() AT TIME ZONE 'UTC')::date-2+interval '12 hours'),
      ($2,'human','Returning customer',now()-interval '30 days')`,
      [customer, returning],
    );
    await db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
      ('signup-android',$1,'android','physical'),('signup-ios',$1,'ios','physical')`,
      [customer],
    );
    // One account across two installs, plus another returning account and an abandoned attempt.
    for (const [index, identity, platform, newAccount] of [
      [1, customer, 'android', true],
      [2, customer, 'ios', false],
      [3, returning, 'android', false],
      [4, null, 'android', false],
    ] as const) {
      const event = {
        event: 'provider_tapped' as const,
        installId: randomUUID(),
        attemptId: randomUUID(),
        platform,
        provider: 'github' as const,
        version: '0.2.22',
        environment: 'production' as const,
        timestamp: new Date().toISOString(),
      };
      await recordSigninFunnelEvent(db, event, 'server');
      await db.query(
        `UPDATE signin_funnel_events SET occurred_at=(now() AT TIME ZONE 'UTC')::date-2+interval '12 hours'+$2::int*interval '1 hour'
        WHERE install_id=$1`,
        [event.installId, newAccount ? -1 : index],
      );
      if (identity) {
        await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'server', identity);
        // A repeated authenticated notification must not add another completion.
        await recordSigninFunnelEvent(db, { ...event, event: 'signed_in' }, 'client', identity);
        await db.query(
          `UPDATE signin_funnel_events SET occurred_at=(now() AT TIME ZONE 'UTC')::date-2+interval '18 hours'
          WHERE install_id=$1 AND event<>'provider_tapped'`,
          [event.installId],
        );
      }
    }
    const through = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const response = await get('?platforms=android,ios');
    expect(response.status).toBe(200);
    const value = await response.json();
    const total = value.signinFunnel.perPlatform.find((p: any) => p.platform === 'all');
    expect(total.stages.find((s: any) => s.stage === 'signup')).toMatchObject({
      count: 1,
      denominator: 3,
      dropOffCount: 2,
      dropOffRate: 2 / 3,
    });
    expect(value.signinFunnel.from).toBe(through);
    expect(value.signinFunnel.through).toBe(through);
    expect(total.providers[0].series).toContainEqual({
      period: 'weekly',
      date: through,
      stage: 'signup',
      outcome: '',
      count: 1,
    });
    expect(total.signup).toMatchObject({ unit: 'people', count: 1 });
    expect(total.series).toContainEqual({
      period: 'weekly',
      date: through,
      stage: 'signup',
      count: 1,
    });
    const android = await (await get('?platforms=android')).json();
    expect(
      android.signinFunnel.perPlatform[0].stages.find((s: any) => s.stage === 'signup'),
    ).toMatchObject({ count: 1, denominator: 2, dropOffCount: 1, dropOffRate: 0.5 });
    const ios = await (await get('?platforms=ios')).json();
    expect(
      ios.signinFunnel.perPlatform[0].stages.find((s: any) => s.stage === 'signup'),
    ).toMatchObject({ count: 0, denominator: 1, dropOffCount: 1, dropOffRate: 1 });
    expect(value.usage.people.find((s: any) => s.stage === 'signup').count).toBe(1);
  });
  it('validates anonymous events at the HTTP boundary and rate limits without persisting personal fields', async () => {
    const input={event:'app_opened',installId:'00000000-0000-4000-8000-000000000001',attemptId:'00000000-0000-4000-8000-000000000002',platform:'android',version:'0.2.22',environment:'production',timestamp:new Date().toISOString()};
    const send=(data:unknown,ip='funnel-proof')=>fetch(`${base}/v1/funnel/events`,{method:'POST',headers:{'content-type':'application/json','fly-client-ip':ip},body:JSON.stringify(data)});
    expect((await send({...input,email:'private@example.com'})).status).toBe(400);
    expect((await send({...input,event:'signed_in',provider:'github'})).status).toBe(401);
    expect((await send({...input,event:'signup',provider:'github'})).status).toBe(400);
    expect((await send({...input,version:'x'.repeat(2000)})).status).toBe(400);
    expect((await send(input)).status).toBe(204);
    expect((await send(input)).status).toBe(204);
    expect((await send({...input,environment:'lab'})).status).toBe(204);
    const rows=(await db.query(`SELECT * FROM signin_funnel_events`)).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('private@example.com');
    expect(JSON.stringify(rows)).not.toContain('funnel-proof');
    // Invalid input also spends the per-IP budget, before body parsing or storage.
    for(let i=0;i<60;i++)expect((await send({},'rate-proof')).status).toBe(400);
    expect((await send({},'rate-proof')).status).toBe(429);
  });

  it('serves Downloads before Signup with aligned cached counts through the authenticated endpoint', async () => {
    await seed();
    await db.query(`UPDATE identities SET created_at=(now() AT TIME ZONE 'UTC')::date-2 WHERE kind='human'`);
    await db.query(`INSERT INTO store_download_days(platform,day,installs,source,fetched_at,attempted_at,final)
      SELECT 'android',d,10,'Play',now(),now(),true FROM generate_series(
        (now() AT TIME ZONE 'UTC')::date-89,(now() AT TIME ZONE 'UTC')::date-2,interval '1 day') d`);
    const response = await get('?platforms=android');
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.downloads).toMatchObject({ stage: 'downloads', nextStage: 'signup', state: 'measured', count: 880,
      comparison: { downloads: 880, signups: 6, dropOffCount: 874, dropOffRate: 874/880 } });
    expect(value.usage.people[0]).toMatchObject({ stage: 'signup', count: 6 });
    expect(value.overview.series.downloads.data.weekly.at(-1).value).toBe(70);
    expect(value.overview.sources.downloadsAndroid.state).toBe('measured');
    const web = await (await get('?platforms=web')).json();
    expect(web.downloads).toMatchObject({ state: 'not_measured', count: null });
  });

  it('serves bounded UTC series, deduplicated cohorts, retention and live helper evidence without content', async () => {
    await seed();
    const today = new Date().toISOString().slice(0, 10);
    const human = `a${(1).toString(16).padStart(63, '0')}`;
    const other = `a${(2).toString(16).padStart(63, '0')}`;
    const agent = `b${(1).toString(16).padStart(63, '0')}`;
    const stale = `b${(2).toString(16).padStart(63, '0')}`;
    await db.query(`UPDATE identities SET created_at=$2::timestamptz-interval '15 days' WHERE id=$1`, [human, today]);
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('multi',$1,'android','physical')`, [human]);
    await db.query(`UPDATE memberships SET invited_by=$1,joined_at=$3::timestamptz WHERE identity_id=$2 AND room_id IS NULL`, [human, other, today]);
    for (const [id, interval] of [['recent', 0], ['return', 8], ['old', 100]] as const) {
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
        VALUES($1,$2,$3,$4,$5::timestamptz-($6::int*interval '1 day'))`, [id, room, human, secret, today, interval]);
    }
    await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('live',now()),('stale',now()-interval '5 minutes')`);
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
      VALUES($1,1,'connection-live','live'),($2,1,'connection-stale','stale')`, [agent, stale]);
    const query = vi.spyOn(db, 'query');
    const value = await dashboardOverview(db, ['ios','android'], new Date().toISOString());
    expect(value.series.signups).toMatchObject({ state: 'measured' });
    if (value.series.signups?.state !== 'measured' || value.series.dau?.state !== 'measured') throw new Error('Series unavailable');
    expect(value.series.signups.data.daily).toHaveLength(90);
    expect(value.series.signups.data.daily.reduce((sum, p) => sum+p.value, 0)).toBe(12);
    expect(value.series.dau.data.daily.at(-1)?.value).toBe(1);
    expect(value.series.dau.data.daily.reduce((sum, p) => sum+p.value, 0)).toBe(2); // older than 90d excluded
    expect(value.retention).toMatchObject({ state: 'measured', data: { cohort: 1, retained: 1, rate: 1 } });
    expect(value.helpers).toMatchObject({ state: 'measured', data: { paired: 12, online: 1, share: 1/12 } });
    expect(value.spend).toMatchObject({ state: 'measured', data: { usd: null } }); // absent ledger is not a measured zero
    expect(value.sources.downloadsAndroid).toMatchObject({ state: 'not_connected' });
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(JSON.stringify(value)).not.toContain(human);
    expect(query.mock.calls.every(([sql]) => /^(WITH|SELECT)\s/.test(sql))).toBe(true);
    const empty = await dashboardOverview(db, ['linux'], new Date().toISOString());
    expect(empty.retention).toMatchObject({ state: 'measured', data: { cohort: 0, retained: 0, rate: null } });
    if (empty.series.signups?.state !== 'measured') throw new Error('Empty read unavailable');
    expect(empty.series.signups.data.daily.every(p => p.value === 0)).toBe(true);
  });

  it('isolates a failed history read without manufacturing zeroes or leaking database errors', async () => {
    const original = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation((sql, values) => {
      if (sql.includes('FROM eligible WHERE created_at') || sql.includes('FROM agent_turns')) return Promise.reject(new Error(secret));
      return original(sql, values);
    });
    const result = await dashboardOverview(db, ['ios'], new Date().toISOString());
    expect(result.series.signups).toEqual({ state: 'unavailable', measuredAt: null });
    expect(result.series.workspaces?.state).toBe('measured');
    expect(JSON.stringify(result)).not.toContain(secret);
    const health = await dashboardHealth(db, new Date().toISOString());
    expect(health.failing.failed).toBeNull();
    expect(health.failing.total).toBeNull();
  });

  it('counts small web and desktop cohorts exactly and excludes review, proof and hidden identities', async () => {
    await seed();
    const proof = 'c2e54c45-cf58-4cc1-a620-89b196096e7b';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Firstmate Proof')`, [proof]);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Play Review')`, [
      REVIEW_IDENTITY_ID,
    ]);
    const rigHuman = 'c'.repeat(64),
      rigAgent = 'd'.repeat(64),
      hidden = 'e'.repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name,hidden_from_roster)
      VALUES($1,'human','Proof human',false),($2,'agent','Proof agent',false),($3,'human','System',true)`,
      [rigHuman, rigAgent, hidden],
    );
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [rigAgent, rigHuman]);
    for (const id of [rigHuman, rigAgent, REVIEW_IDENTITY_ID]) {
      await db.query(
        `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,
        [proof, id],
      );
    }
    const human = `a${(1).toString(16).padStart(63, '0')}`;
    await db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,
      [proof, human],
    );
    await db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
      VALUES('web-person',$1,'web','physical'),('web-proof',$2,'web','physical')`,
      [human, rigHuman],
    );
    for (const id of [rigHuman, REVIEW_IDENTITY_ID]) {
      await db.query(
        `INSERT INTO device_update_receipts(identity_id,device_id,receipt)
        VALUES($1,'fixture-phone','{"platform":"android","releaseVersion":"v2"}'::jsonb)`,
        [id],
      );
    }
    const all = await (await get()).json();
    expect(all.ops.release.activePhones).toBe(12);
    expect(all.usage.people[0].count).toBe(12);
    expect(all.usage.agents[0].count).toBe(12);
    expect(all.usage.workspaces).toBe(1);
    expect(all.usage.platformCoverage).toEqual(['ios', 'android', 'web']);
    const web = await (await get('?platforms=web')).json();
    expect(web.usage.people[0].count).toBe(1);
    expect(web.usage.agents[0].count).toBe(1);
    expect(web.usage.workspaces).toBe(1);
    const mac = await (await get('?platforms=macos')).json();
    expect(mac.usage.people.every((stage: { count: number }) => stage.count === 0)).toBe(true);
    expect(mac.usage.workspaces).toBe(0);
    const combined = await (await get('?platforms=web,ios')).json();
    expect(combined.usage.people[0].count).toBe(6); // overlapping observations count once
    await db.query(
      `UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND workspace_id=$2`,
      [human, workspace],
    );
    const departed = await (await get('?platforms=web')).json();
    expect(departed.usage.people[0].count).toBe(1); // a real signup survives departure
    expect(departed.usage.workspaces).toBe(0);
  });

  it('refuses missing and wrong keys before reading totals', async () => {
    const query = vi.spyOn(db, 'query');
    expect((await fetch(`${base}/v1/admin/dashboard`)).status).toBe(403);
    expect((await get('', 'phone-key')).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('recomputes all-platform and selected-platform cohorts without disclosing content', async () => {
    await seed();
    vi.stubEnv('BEELINE_DASHBOARD_LATEST_MOBILE_RELEASE', 'v2');
    const all = await get();
    expect(all.status).toBe(200);
    const allText = await all.text();
    expect(allText).not.toContain(secret);
    expect(allText).not.toContain('message-1');
    const allBody = JSON.parse(allText);
    expect(allBody.platforms).toEqual(['ios', 'android', 'web', 'macos', 'windows', 'linux']);
    expect(allBody.usage.people[0].count).toBe(12);
    expect(allBody.usage.people[2].count).toBe(12);
    expect(allBody.usage.people[2]).toMatchObject({
      timeToStepState: 'measured',
    });
    expect(allBody.usage.people[2].medianTimeToStepMs).toBeGreaterThanOrEqual(0);
    expect(allBody.usage.agents[2].count).toBe(12);
    const explicitAll = await (await get('?platforms=ios,android,web,macos,windows,linux')).json();
    expect(explicitAll.usage.people).toEqual(allBody.usage.people);
    expect(allBody.ops.release.latestShare).toBe(0.5);
    const ios = await get('?platforms=ios');
    const iosBody = await ios.json();
    expect(iosBody.usage.people[0].count).toBe(6);
    expect(iosBody.usage.agents[2].count).toBe(6);
    expect(iosBody.platforms).toEqual(['ios']);
    expect((await get('?platforms=macos')).status).toBe(200);
    expect((await (await get('?platforms=macos')).json()).usage).toMatchObject({
      state: 'measured',
    });
    for (let index = 1; index <= 5; index++) {
      const human = `a${index.toString(16).padStart(63, '0')}`;
      await db.query(
        `INSERT INTO device_update_receipts(identity_id,device_id,receipt) VALUES($1,$2,$3::jsonb)`,
        [human, `desktop-${index}`, JSON.stringify({ platform: 'macos', releaseVersion: 'v2' })],
      );
    }
    const mac = await (await get('?platforms=macos')).json();
    expect(mac.usage).toMatchObject({ state: 'measured' });
    expect(mac.usage.people[0].count).toBe(5);
    expect(mac.ops.release.activePhones).toBe(12); // desktop receipts do not enter phone reach
    expect((await get('?platforms=ios,ios')).status).toBe(400);
  });

  it('omits token attribution without a measured memory token count', async () => {
    await seed();
    const human = `a${(1).toString(16).padStart(63, '0')}`;
    const agent = `b${(1).toString(16).padStart(63, '0')}`;
    await db.query(
      `INSERT INTO institutional_context_serves
      (id,workspace_id,room_id,agent_id,request_id,requester_identity_id,mode,served,total_bytes,estimated_tokens)
      VALUES($1,$2,$3,$4,'turn-1',$5,'live',true,500,125)`,
      ['30000000-0000-4000-8000-000000000801', workspace, room, agent, human],
    );
    const result = await dashboardOps(db, new Date().toISOString(), 'v2');
    expect(result.memory).not.toHaveProperty('tokenShare');
  });

  it('never presents byte-proportional token attribution as measured', async () => {
    await seed();
    const human = `a${(1).toString(16).padStart(63, '0')}`;
    const agent = `b${(1).toString(16).padStart(63, '0')}`;
    for (let index = 0; index < 6; index++) {
      const counted = index < 5;
      await db.query(
        `INSERT INTO institutional_context_serves
        (id,workspace_id,room_id,agent_id,request_id,requester_identity_id,mode,served,total_bytes,
          estimated_tokens,prompt_bytes,actual_input_tokens)
        VALUES($1,$2,$3,$4,$5,$6,'live',true,100,25,$7,$8)`,
        [
          `30000000-0000-4000-8000-00000000090${index}`,
          workspace,
          room,
          agent,
          `turn-${index}`,
          human,
          counted ? 1000 : null,
          counted ? 400 : null,
        ],
      );
    }
    const result = await dashboardOps(db, new Date().toISOString(), 'v2');
    expect(result.memory).not.toHaveProperty('tokenShare');
  });

  it('does not infer the latest mobile build from the server release or count unknown platforms as phones', async () => {
    await seed();
    vi.stubEnv('BEELINE_RELEASE_VERSION', 'v2');
    const human = `a${(1).toString(16).padStart(63, '0')}`;
    await db.query(
      `INSERT INTO device_update_receipts(identity_id,device_id,receipt)
      VALUES($1,'unknown-platform','{}'::jsonb)`,
      [human],
    );
    const result = await (await get()).json();
    expect(result.ops.release).toMatchObject({
      activePhones: 12,
      latestVersion: null,
      latestShare: null,
    });
  });

  it('measures the latest-build share over phones with a known build', async () => {
    await seed();
    await db.query(`UPDATE device_update_receipts SET receipt=receipt-'releaseVersion'
      WHERE device_id='device-12'`);
    const result = await dashboardOps(db, new Date().toISOString(), 'v2');
    // 12 receipts: 6 on v2, 5 on v1, 1 unknown. Share uses the 11 known phones.
    expect(result.release).toMatchObject({
      latestShare: 6 / 11,
      activePhones: 12,
      latestPhones: 6,
      unknownBuildPhones: 1,
    });
  });

  it('derives funnel time from each person’s actual stage timestamps', async () => {
    await seed();
    await db.query(`UPDATE identities SET created_at=now()-interval '3 hours' WHERE kind='human'`);
    await db.query(`UPDATE memberships SET joined_at=now()-interval '2 hours'
      WHERE room_id IS NULL AND identity_id IN (SELECT id FROM identities WHERE kind='human')`);
    await db.query(`UPDATE daemon_tokens SET created_at=now()-interval '1 hour'`);
    const result = await (await get()).json();
    expect(result.usage.people[1].timeToStepState).toBe('measured');
    expect(result.usage.people[2].timeToStepState).toBe('measured');
    expect(Math.abs(result.usage.people[1].medianTimeToStepMs - 3_600_000)).toBeLessThan(1000);
    expect(Math.abs(result.usage.people[2].medianTimeToStepMs - 3_600_000)).toBeLessThan(1000);
  });

  it('keeps funnel counts when the optional timing read fails', async () => {
    await seed();
    const original = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation((async (sql, params) => {
      if (String(sql).includes('workspace_times AS')) throw new Error('timing unavailable');
      return original(sql, params);
    }) as typeof db.query);
    const result = await (await get()).json();
    expect(result.usage.state).toBe('measured');
    expect(result.usage.people[2]).toMatchObject({
      count: 12,
      timeToStepState: 'unmeasured',
      medianTimeToStepMs: null,
    });
  });

  it('measures store-only runtimes when release thresholds exist, and isolates a bad memory read', async () => {
    await seed();
    const original = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation((async (sql, params) => {
      if (String(sql).includes('repeat_events AS')) throw new Error(`private ${secret}`);
      return original(sql, params);
    }) as typeof db.query);
    const result = await dashboardOps(db, new Date().toISOString(), 'v2', { ios: 31, android: 31 });
    expect(result.release).toMatchObject({
      state: 'measured',
      storeUpdateState: 'measured',
      storeUpdateOnlyPhones: 12,
    });
    expect(result.memory.repeatCorrections.state).toBe('unavailable');
    expect(result.memory).not.toHaveProperty('tokenShare');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('ignores an instant slow query and judges the ten-minute distribution', async () => {
    await seed();
    const agent = `b${(1).toString(16).padStart(63, '0')}`;
    for (let index = 0; index < 20; index++) {
      await db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,$4)`,
        [room, `turn-${index}`, agent, index < 2 ? 'failed' : 'complete'],
      );
    }
    const window = new QueryWindow();
    for (let index = 0; index < 40; index++) {
      window.recordQuery(index === 0 ? 6001 : 20);
      window.recordCheckout(2, 0);
    }
    const measuredDb = {
      query: db.query.bind(db),
      transaction: db.transaction.bind(db),
      poolCounts: () => ({ total: 5, idle: 5, waiting: 1 }),
      oldestActiveQueryAgeMs: async () => 6001,
      queryWindow: () => window.snapshot(),
    } as SqlDatabase;
    const stable = await dashboardHealth(measuredDb, new Date().toISOString());
    expect(stable.server.verdict).toBe('green');
    expect(stable.slow).toMatchObject({
      verdict: 'unmeasured',
      function: null,
      windowMinutes: 10,
      queryP95Ms: 20,
      queryP99Ms: 6001,
      currentWaiters: 1,
    });
    expect(stable.failing).toMatchObject({ verdict: 'red', function: 'agent_turn' });
    for (let index = 0; index < 20; index++) {
      window.recordQuery(6001);
      window.recordCheckout(220, 1);
    }
    const degraded = await dashboardHealth(measuredDb, new Date().toISOString());
    expect(degraded.slow).toMatchObject({ verdict: 'red', function: 'database.query' });
    expect(degraded.slow.queryP95Ms).toBe(6001);
    await db.query(`UPDATE agent_turns SET status='complete'`);
    const incomplete = await dashboardHealth(measuredDb, new Date().toISOString());
    expect(incomplete.failing).toMatchObject({
      verdict: 'unmeasured',
      measuredFunctions: ['agent_turn'],
    });
    expect(incomplete.failing.unmeasuredFunctions).toContain('attachment_upload');
  });

  it('uses completed page and push events, not synthetic counts', async () => {
    await seed();
    const unauthenticated = await fetch(`${base}/v1/phone/observations/page-load`, {
      method: 'POST',
      body: JSON.stringify({ durationMs: 120, failed: false }),
    });
    expect(unauthenticated.status).toBe(401);
    const accepted = await fetch(`${base}/v1/phone/observations/page-load`, {
      method: 'POST',
      headers: { authorization: 'Bearer phone-key-for-dashboard-test' },
      body: JSON.stringify({ durationMs: 120, failed: false }),
    });
    expect(accepted.status).toBe(204);
    for (let index = 1; index <= 5; index++) {
      await db.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status,claimed_at,completed_at)
        VALUES($1,$2,'delivered',now()-interval '2 seconds',now())`,
        [`message-${index}`, `push-${index}`],
      );
    }
    const health = await dashboardHealth(db, new Date().toISOString());
    expect(health.functions.find((item) => item.function === 'page_load')).toMatchObject({
      state: 'unmeasured',
      total: 1,
    });
    expect(health.functions.find((item) => item.function === 'push_delivery')).toMatchObject({
      state: 'measured',
      total: 5,
    });
    expect(
      (
        await db.query(
          `SELECT count(*) total FROM operator_function_events WHERE function_name='page_load'`,
        )
      ).rows[0]?.total,
    ).toBe(1);
    for (let index = 0; index < 19; index++) {
      await db.query(
        `INSERT INTO operator_function_events(function_name,duration_ms,failed)
        VALUES('page_load',$1,$2)`,
        [6001, index < 2],
      );
    }
    const degraded = await dashboardHealth(db, new Date().toISOString());
    expect(degraded.slow).toMatchObject({ verdict: 'red', function: 'page_load' });
    expect(degraded.failing).toMatchObject({ verdict: 'red', function: 'page_load' });
    expect(degraded.functions.find((item) => item.function === 'page_load')).toMatchObject({
      state: 'measured',
      verdictSampleState: 'sufficient',
      total: 20,
      p95Ms: 6001,
      failureRate: 0.1,
    });
  });

  it('stores a bounded Room read network residual on the existing page observation', async () => {
    const endpoint = `${base}/v1/phone/observations/page-load`;
    const headers = { authorization: 'Bearer phone-key-for-dashboard-test' };
    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        durationMs: 120,
        failed: false,
        network: { requestToFirstByteMs: 94.5, serverProcessingMs: 13.2 },
      }),
    });
    expect(accepted.status).toBe(204);
    expect(
      (
        await db.query<{ network_rtt_residual_ms: number }>(
          `SELECT network_rtt_residual_ms FROM operator_function_events WHERE function_name='page_load'`,
        )
      ).rows[0]?.network_rtt_residual_ms,
    ).toBe(81);
    const rejected = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        durationMs: 120,
        failed: false,
        network: { requestToFirstByteMs: 10, serverProcessingMs: 11 },
      }),
    });
    expect(rejected.status).toBe(400);
  });
});
