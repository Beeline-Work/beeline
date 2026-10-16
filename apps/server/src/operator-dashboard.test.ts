import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createBeelineServer } from './server.js';
import { dashboardHealth, dashboardOps } from './operator-dashboard.js';
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
