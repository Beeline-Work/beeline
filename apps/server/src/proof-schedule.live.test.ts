import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { createMonolithAuth } from './monolith-auth.js';

const HUMAN = createHash('sha256').update('github:proof-owner').digest('hex');
const AGENT = 'e'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

// End-to-end proof: a real 1-minute-cadence schedule created over daemon HTTP
// fires five times through the real AgentScheduleLoop and deletes itself.
describe('end-to-end agent schedule proof', () => {
  let database: PgliteDatabase;
  let server: ReturnType<typeof createBeelineServer>;
  let mountedAuth: Awaited<ReturnType<typeof createMonolithAuth>>;
  let origin: string;
  let daemonToken: string;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Bee')`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    const auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof;
      return { subject: login, login, name: 'Owner' };
    });
    const phone = new PhoneService(database, auth);
    const live = new LiveHub();
    const daemon = new DaemonService(database, live);
    mountedAuth = await createMonolithAuth(database, 'https://server.test', undefined, {
      createDaemonExchange: (agentId, transaction) =>
        auth.createDaemonExchange(agentId, transaction),
      env: {
        NODE_ENV: 'test',
        BUZZY_AUTH_TENANTS_JSON: JSON.stringify([
          {
            host: 'server.test',
            community: 'integration-community',
            roomCommunityIds: ['integration-community'],
            origin: 'https://server.test',
          },
        ]),
        BUZZY_AUTH_OIDC_ISSUER: 'https://accounts.example',
        BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
        BUZZY_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
        BUZZY_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
        BUZZY_AUTH_OIDC_CLIENT_ID: 'test-client',
      },
    });
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon,
      live,
      authHandler: mountedAuth.handle,
      mediaMaximumBytes: 1024 * 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const exchange = await auth.createDaemonExchange(AGENT);
    daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (mountedAuth) await mountedAuth.close();
    if (database) await database.close();
  });

  it('runs a 1-minute 5-run schedule to completion and self-deletes', { timeout: 15 * 60_000 }, async () => {
    const daemonOperation = async (name: string, payload: unknown) =>
      fetch(`${origin}/v1/daemon/operations/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemonToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const startedAt = new Date();
    const created = await daemonOperation('createAgentSchedule', {
      agentId: AGENT,
      roomId: ROOM,
      prompt: "message 'hello @bananaman614305'",
      cadence: { kind: 'interval', everyMinutes: 1 },
      maxRuns: 5,
    });
    expect(created.status).toBe(200);
    const { scheduleId, nextRunAt } = (await created.json()) as {
      scheduleId: string;
      nextRunAt: number;
    };
    console.log(`[proof] schedule ${scheduleId} created; first run at ${new Date(nextRunAt * 1_000).toISOString()}`);

    // Drive the real loop against the real HTTP-backed server until all five
    // runs have fired and the schedule has removed itself.
    const loop = new AgentScheduleLoop(database);
    const deadline = Date.now() + 14 * 60_000;
    let messages = 0;
    while (Date.now() < deadline) {
      await loop.runOnce();
      const result = await daemonOperation('listAgentSchedules', { agentId: AGENT, roomId: ROOM });
      const list = (await result.json()) as { schedules: Array<{ runCount: number }> };
      if (!list.schedules.length) break;
      messages = list.schedules[0]?.runCount ?? messages;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const finishedAt = new Date();
    const stored = await database.query<{ text: string; author_id: string; mention_ids: string[] }>(
      `SELECT text,author_id,mention_ids FROM messages ORDER BY created_at`,
    );
    console.log(`[proof] wall-clock ${(finishedAt.getTime() - startedAt.getTime()) / 1_000}s; fired ${stored.rowCount} runs`);
    for (const row of stored.rows) console.log(`[proof] fired: ${JSON.stringify(row)}`);
    expect(stored.rowCount).toBe(5);
    for (const row of stored.rows) {
      expect(row.author_id).toBe(AGENT);
      expect(row.mention_ids).toEqual([AGENT]);
    }
    expect(
      (await database.query(`SELECT 1 FROM agent_schedules WHERE id=$1`, [scheduleId])).rowCount,
    ).toBe(0);
    const gone = await daemonOperation('listAgentSchedules', { agentId: AGENT, roomId: ROOM });
    await expect(gone.json()).resolves.toEqual({ schedules: [] });
    console.log('[proof] PASS: 1-minute schedule fired 5 real runs and deleted itself');
  });
});
