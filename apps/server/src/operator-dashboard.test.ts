import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createBeelineServer } from './server.js';
import { dashboardHealth, dashboardOps } from './operator-dashboard.js';
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
    auth: {} as TokenAuth,
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
    expect(allBody.platforms).toEqual(['ios', 'android', 'macos', 'windows', 'linux']);
    expect(allBody.usage.people[0].count).toBe(10);
    expect(allBody.usage.people[2].count).toBe(10);
    expect(allBody.usage.people[2]).toMatchObject({
      medianTimeToStepMs: null,
      timeToStepState: 'unmeasured',
    });
    expect(allBody.usage.agents[2].count).toBe(10);
    const explicitAll = await (await get('?platforms=ios,android,macos,windows,linux')).json();
    expect(explicitAll.usage.people).toEqual(allBody.usage.people);
    expect(allBody.ops.release.latestShare).toBe(0.5);
    const ios = await get('?platforms=ios');
    const iosBody = await ios.json();
    expect(iosBody.usage.people[0].count).toBe(5);
    expect(iosBody.usage.agents[2].count).toBe(5);
    expect(iosBody.platforms).toEqual(['ios']);
    expect((await get('?platforms=macos')).status).toBe(200);
    expect((await (await get('?platforms=macos')).json()).usage).toMatchObject({
      state: 'unmeasured',
      reason: 'desktop_platform_not_recorded',
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
    expect(mac.ops.release.activePhones).toBe(10); // desktop receipts do not enter phone reach
    expect((await get('?platforms=ios,ios')).status).toBe(400);
  });

  it('marks missing Codex token usage unmeasured rather than zero', async () => {
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
    expect(result.memory.tokenShare).toMatchObject({ state: 'unmeasured', share: null });
  });

  it('measures store-only runtimes when release thresholds exist, and isolates a bad memory read', async () => {
    await seed();
    const original = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation((async (sql, params) => {
      if (String(sql).includes('WITH repeat_events')) throw new Error(`private ${secret}`);
      return original(sql, params);
    }) as typeof db.query);
    const result = await dashboardOps(db, new Date().toISOString(), 'v2', { ios: 31, android: 31 });
    expect(result.release).toMatchObject({
      state: 'measured',
      storeUpdateState: 'measured',
      storeUpdateOnlyPhones: 10,
    });
    expect(result.memory.repeatCorrections.state).toBe('unavailable');
    expect(result.memory.tokenShare.state).toBe('unmeasured');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not report overall green when only database and turn telemetry exist', async () => {
    await seed();
    const agent = `b${(1).toString(16).padStart(63, '0')}`;
    for (let index = 0; index < 20; index++) {
      await db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,$4)`,
        [room, `turn-${index}`, agent, index < 2 ? 'failed' : 'complete'],
      );
    }
    const measuredDb = {
      query: db.query.bind(db),
      transaction: db.transaction.bind(db),
      poolCounts: () => ({ total: 5, idle: 5, waiting: 0 }),
      oldestActiveQueryAgeMs: async () => 6001,
    } as SqlDatabase;
    const red = await dashboardHealth(measuredDb, new Date().toISOString());
    expect(red.server.verdict).toBe('green');
    expect(red.slow).toMatchObject({ verdict: 'red', function: 'database.query' });
    expect(red.failing).toMatchObject({ verdict: 'red', function: 'agent_turn' });
    await db.query(`UPDATE agent_turns SET status='complete'`);
    const incomplete = await dashboardHealth(measuredDb, new Date().toISOString());
    expect(incomplete.failing).toMatchObject({
      verdict: 'unmeasured',
      measuredFunctions: ['agent_turn'],
    });
    expect(incomplete.failing.unmeasuredFunctions).toContain('attachment_upload');
  });
});
