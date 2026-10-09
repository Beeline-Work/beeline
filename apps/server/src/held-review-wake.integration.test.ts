import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAgentCommand } from './agent-command.js';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const HUMAN = '1'.repeat(64), WORKER = 'b'.repeat(64), REVIEWER = 'c'.repeat(64);

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;
  constructor(private readonly database: PgliteDatabase) {
    super();
  }
  async connect(): Promise<void> {}
  async query(sql: string): Promise<void> {
    if (sql !== `LISTEN ${POSTGRES_LIVE_CHANNEL}`) throw new Error(`unexpected query: ${sql}`);
    this.release = await this.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) =>
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload }));
  }
  async end(): Promise<void> {
    await this.release?.();
    this.release = undefined;
  }
}

let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, listener: PostgresLiveListener;
let origin: string;
const tokens = new Map<string, string>();

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  for (const [id, kind, name] of [[HUMAN, 'human', 'Human'], [WORKER, 'agent', 'Worker'], [REVIEWER, 'agent', 'Reviewer']])
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,$2,$3)`, [id, kind, name]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [WORKER, REVIEWER, HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Held review proof')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,reviewer_agent_id) VALUES($1,$2,'Team',$3)`, [PARENT, WORKSPACE, REVIEWER]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`, [CORNER, WORKSPACE, PARENT, HUMAN]);
  for (const room of [null, PARENT, CORNER])
    for (const who of [HUMAN, WORKER, REVIEWER])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, room, who]);
  const auth = new TokenAuth(db, async () => ({ subject: 'proof', login: 'proof' }));
  const live = new LiveHub();
  listener = new PostgresLiveListener(db, live, () => new PgliteListenClient(db), 1);
  void listener.run();
  server = createBeelineServer({ database: db, auth, live, phone: new PhoneService(db, 'http://placeholder'), daemon: new DaemonService(db, live) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const agent of [WORKER, REVIEWER]) tokens.set(agent,
    (await auth.exchangeDaemonToken((await auth.createDaemonExchange(agent)).exchangeToken))!.daemonToken);
}, 30_000);

afterAll(async () => {
  await listener?.stop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

async function call(agent: string, operation: string, payload: object) {
  const response = await fetch(`http://${origin}/v1/daemon/operations/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.get(agent)}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function source(text: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [id, CORNER, HUMAN, text]);
  return id;
}

describe('Reproduction S-07 end to end: a held review wake reaches the reviewer helper', () => {
  it('delivers the review command when the worker finishes, with no viewer and no helper reconnect', async () => {
    // The worker is mid-turn: its command holds a live lease.
    const work = await createAgentCommand(db, { roomId: CORNER, agentId: WORKER, sourceMessageId: await source('@worker fix it'), reason: 'human_message' });
    const generationId = randomUUID();
    await call(WORKER, 'claimAgentCommand', { roomId: CORNER, commandId: work!.id, generationId });
    const turn = { roomId: CORNER, requestId: work!.turn_request_id, generationId, agentId: WORKER };
    await call(WORKER, 'postAgentTurnReceipt', { ...turn, status: 'working' });

    // The reviewer's helper watches the corner on one socket for the whole test.
    const socket = new WebSocket(`ws://${origin}/v1/phone/live`, [`bearer.${tokens.get(REVIEWER)}`]);
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId: CORNER }));
    await expect.poll(() => frames.some((frame) => frame.type === 'commands')).toBe(true);

    // CI turns green while the worker is busy: the review wake is queued and held.
    const review = await createAgentCommand(db, { roomId: CORNER, agentId: REVIEWER, sourceMessageId: await source('Checks passed'), reason: 'corner_check' });
    const delivered = () => frames.some((frame) =>
      frame.type === 'commands' && (frame.commands as { id: string }[]).some((command) => command.id === review!.id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delivered()).toBe(false);

    // The worker's turn ends. Nobody opens the corner and the helper keeps its socket.
    await call(WORKER, 'postAgentTurnReceipt', { ...turn, status: 'complete' });
    expect((await db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [work!.id])).rows[0]?.state)
      .toBe('complete');
    await expect.poll(delivered, { timeout: 5_000 }).toBe(true);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
