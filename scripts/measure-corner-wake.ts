/**
 * Measures what a streaming corner turn costs the server.
 *
 * Stands up a real Beeline server on 127.0.0.1 (PGlite), seeds one corner
 * owned by one agent, then runs the two halves of a live corner side by side
 * for a fixed window:
 *
 *  - the intake loop, exactly as `MonolithCornerTurnLoop` runs it: poll
 *    `getCornerCloseRequests`, then race a sleep against `waitForCornerWake`;
 *  - the turn, scripted: one `postAgentDraft` every 50ms plus an activity row
 *    and a working receipt every second — a model streaming a long answer.
 *
 * Every HTTP request is counted at the socket, so the number printed is the
 * number the production server would see. Run it on this branch and on the
 * commit before it to get the before/after rates.
 *
 *   npm run measure:corner-wake -- [seconds]
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';

const WINDOW_MS = Number(process.argv[2] ?? 30) * 1_000;
const DRAFT_INTERVAL_MS = 50;
const SLOW_LANE_INTERVAL_MS = 1_000;
const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

async function main(): Promise<void> {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,github_subject) VALUES($1,'human','Owner','owner'),($2,'agent','Bee',NULL)`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General'),($3,$2,'corner')`,
    [ROOM, WORKSPACE, CORNER],
  );
  await database.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [CORNER, ROOM]);
  await database.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,objective) VALUES($1,$2,'measure')`, [
    CORNER,
    AGENT,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM, CORNER],
  );

  const auth = new TokenAuth(database, async () => ({
    subject: 'owner',
    login: 'owner',
    name: 'Owner',
  }));
  const live = new LiveHub();
  const daemon = new DaemonService(database, live);
  const phone = new PhoneService(database, 'http://127.0.0.1');
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: 1024 * 1024,
  });
  /** What the server actually served, counted per daemon operation. */
  const served = new Map<string, number>();
  server.on('request', (request) => {
    const name = request.url?.split('/').pop() ?? 'unknown';
    served.set(name, (served.get(name) ?? 0) + 1);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const exchange = await auth.createDaemonExchange(AGENT);
  const daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;

  const call = async (name: string, payload: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemonToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const deadline = Date.now() + WINDOW_MS;
  let intakeIterations = 0;

  /** The corner's intake loop, verbatim in shape: poll, then race sleep vs wake. */
  const intake = (async () => {
    let cursor: string | undefined;
    while (Date.now() < deadline) {
      const inbox = await call('getCornerCloseRequests', {
        cornerId: CORNER,
        ...(cursor ? { after: cursor } : {}),
      });
      cursor = (inbox.cursor as string | undefined) ?? cursor;
      intakeIterations += 1;
      await Promise.race([sleep(12_000), call('waitForCornerWake', { cornerId: CORNER })]);
    }
  })();

  /** The model streaming its answer: a draft delta every 50ms. */
  const turn = (async () => {
    const turnId = randomUUID();
    const requestId = randomUUID().replaceAll('-', '');
    let text = '';
    let sinceSlowLane = 0;
    while (Date.now() < deadline) {
      text += 'token ';
      await call('postAgentDraft', { roomId: CORNER, turnId, text });
      sinceSlowLane += DRAFT_INTERVAL_MS;
      if (sinceSlowLane >= SLOW_LANE_INTERVAL_MS) {
        sinceSlowLane = 0;
        await call('postAgentActivity', {
          roomId: CORNER,
          requestId,
          activity: { kind: 'tool', title: 'read', calls: [] },
        });
        await call('postAgentTurnReceipt', {
          roomId: CORNER,
          requestId,
          status: 'working',
          heartbeat: true,
        });
      }
      await sleep(DRAFT_INTERVAL_MS);
    }
  })();

  await Promise.all([intake, turn]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();

  const seconds = WINDOW_MS / 1_000;
  const rate = (name: string) => ((served.get(name) ?? 0) / seconds).toFixed(2);
  process.stdout.write(
    `${JSON.stringify(
      {
        windowSeconds: seconds,
        draftsPosted: served.get('postAgentDraft') ?? 0,
        intakeIterations,
        perSecond: {
          waitForCornerWake: Number(rate('waitForCornerWake')),
          getCornerCloseRequests: Number(rate('getCornerCloseRequests')),
        },
        totals: Object.fromEntries([...served].sort()),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
