import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundLeader } from './background.js';
import { migrate } from './database.js';
import { LiveHub, type LiveEvent } from './live.js';
import { NeedsYouExpiryLoop } from './needs-you-expiry.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { RoomWebhooks } from './room-webhooks.js';
import { PgliteDatabase } from './test-support.js';

const VIEWER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER_ROOM = '33333333-3333-4333-8333-333333333333';

const DATABASE_SNAPSHOT = await (async () => {
  const database = new PgliteDatabase();
  try {
    await migrate(database);
    return await database.snapshot();
  } finally {
    await database.close();
  }
})();

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;
  readonly payloads: string[] = [];

  constructor(private readonly database: PgliteDatabase) {
    super();
  }

  async connect(): Promise<void> {}

  async query(sql: string): Promise<void> {
    if (sql !== `LISTEN ${POSTGRES_LIVE_CHANNEL}`) throw new Error(`unexpected query: ${sql}`);
    this.release = await this.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) => {
      this.payloads.push(payload);
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload });
    });
  }

  async end(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    await release?.();
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await predicate()).toBe(true);
}

describe('Needs-you expiry sweep', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  let listener: PostgresLiveListener;
  let client: PgliteListenClient;
  let events: LiveEvent[];
  let sequence = 0;

  const expiryWakes = () => client.payloads.filter((payload) => payload.includes('needs_you_marks'));
  const markWakes = () => events.filter((event) => event.type === 'invalidate' &&
    event.reason === 'postgres:needs_you_marks');
  /** What `sendNeedsYouDelta` sends this viewer for the woken Room. */
  const delta = (roomId = ROOM, viewer = VIEWER) => phone.liveNeedsYou(roomId, viewer);
  const read = async (viewer = VIEWER) =>
    (await phone.execute('readNeedsYou', { workspaceId: WORKSPACE }, viewer)).items;

  async function post(text: string, roomId = ROOM): Promise<string> {
    sequence += 1;
    const id = sequence.toString(16).padStart(64, '0');
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$2,$3,$4,now()-interval '1 minute')`,
      [id, roomId, PEER, text],
    );
    return id;
  }

  async function card(cardType: string, body: Record<string, unknown>): Promise<string> {
    sequence += 1;
    const id = `card-${sequence}`.padEnd(64, '0');
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'card','card',$4,$5::jsonb)`,
      [id, ROOM, AGENT, cardType, JSON.stringify(body)],
    );
    return id;
  }

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    sequence = 0;
    database = PgliteDatabase.fromSnapshot(DATABASE_SNAPSHOT);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Ada','ada'),($2,'human','Juniper','juniper'),($3,'agent','Hoots','hoots')`,
      [VIEWER, PEER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, VIEWER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Launch room'),($2,$3,'Elsewhere')`,
      [ROOM, OTHER_ROOM, WORKSPACE],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
         ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),
         ($1,$6,$3,'member')`,
      [WORKSPACE, VIEWER, PEER, AGENT, ROOM, OTHER_ROOM],
    );
    phone = new PhoneService(database, 'https://server.example');
    const live = new LiveHub();
    events = [];
    live.subscribeAll((event) => events.push(event));
    client = new PgliteListenClient(database);
    listener = new PostgresLiveListener(database, live, () => client, 1);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
  });

  afterEach(async () => {
    await listener.stop();
    await database.close();
    vi.restoreAllMocks();
  });

  it('wakes the viewer when a question passes 24 hours from first sight', async () => {
    const question = await post('@ada can you look?');
    expect((await read()).map((item) => item.messageId)).toEqual([question]);
    // Seen just over 24 hours ago, with no write since.
    await database.query(
      `UPDATE needs_you_marks SET first_seen_at=now()-interval '24 hours 1 second'
       WHERE message_id=$1`, [question],
    );
    events.length = 0;
    client.payloads.length = 0;
    await new NeedsYouExpiryLoop(database).runOnce();
    await eventually(() => markWakes().length > 0);
    expect(markWakes()).toEqual([
      expect.objectContaining({ roomId: '', readerId: VIEWER, sourceRoomId: ROOM }),
    ]);
    expect(await delta()).toEqual({ workspaceId: WORKSPACE, count: 0, items: [] });
  });

  it('wakes the owner when an agent sign-in passes its expiresAt', async () => {
    const expiresAt = Date.now() + 200;
    const signIn = await card('agent-sign-in', {
      agentId: AGENT, ownerId: VIEWER, harness: 'claude', status: 'pending', expiresAt,
    });
    const loop = new NeedsYouExpiryLoop(database);
    expect(await loop.runOnce()).toBe(expiresAt);
    expect((await delta()).items.map((item) => item.messageId)).toEqual([signIn]);
    await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now() + 20));
    await loop.runOnce();
    await eventually(() => markWakes().length > 0);
    // Only its owner decides a sign-in.
    expect(markWakes()).toEqual([
      expect.objectContaining({ readerId: VIEWER, sourceRoomId: ROOM }),
    ]);
    expect(await delta()).toEqual({ workspaceId: WORKSPACE, count: 0, items: [] });
  });

  it('wakes the Room people when a Trusty Squire approval passes its expiresAt', async () => {
    const expiresAt = Date.now() + 200;
    const approval = await card('squire-approval', {
      agent: { pubkey: AGENT, kind: 'agent', name: 'Hoots' },
      tool: 'fetch_credential', title: 'Reveal GROQ_API_KEY',
      approvalUrl: 'https://squire.example/approve/1', approvalId: 'approval-1',
      expiresAt, linkKind: 'passkey', sourceRoomId: OTHER_ROOM,
    });
    const loop = new NeedsYouExpiryLoop(database);
    await loop.runOnce();
    expect((await delta()).items.map((item) => item.messageId)).toEqual([approval]);
    await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now() + 20));
    await loop.runOnce();
    await eventually(() => markWakes().length >= 2);
    // Human Room members only; the agent gets no tray.
    expect(markWakes().map((event) => event.type === 'invalidate' && event.readerId).sort())
      .toEqual([VIEWER, PEER].sort());
    expect(await delta()).toEqual({ workspaceId: WORKSPACE, count: 0, items: [] });
  });

  it('leaves webhook expiry to its own job, whose write already wakes the tray', async () => {
    const message = await card('webhook-request', {
      agentName: 'Hoots', source: 'github', reason: 'Watch release tags.', status: 'pending',
    });
    await database.query(
      `INSERT INTO room_webhook_requests(id,room_id,agent_id,source,reason,request_id,message_id,expires_at)
       VALUES('88888888-8888-4888-8888-888888888888',$1,$2,'github','Watch release tags.','request',$3,
         now()+interval '1 hour')`,
      [ROOM, AGENT, message],
    );
    expect((await delta()).items.map((item) => item.messageId)).toEqual([message]);
    await database.query(`UPDATE room_webhook_requests SET expires_at=now()-interval '1 second'`);
    events.length = 0;
    await new RoomWebhooks(database).expireRequests();
    await eventually(() => events.some((event) => event.type === 'invalidate' &&
      event.reason === 'postgres:messages' && event.messageId === message));
    expect(await delta()).toEqual({ workspaceId: WORKSPACE, count: 0, items: [] });
    expect(await new NeedsYouExpiryLoop(database).runOnce()).toBeNull();
  });

  it('sends each deadline once and nothing for a clock that has not run out', async () => {
    const expired = await post('@ada can you look?');
    const fresh = await post('@ada and this one?');
    await read();
    await database.query(
      `UPDATE needs_you_marks SET first_seen_at=now()-interval '24 hours 1 second'
       WHERE message_id=$1`, [expired],
    );
    const loop = new NeedsYouExpiryLoop(database, 0);
    client.payloads.length = 0;
    const next = await loop.runOnce();
    await eventually(() => expiryWakes().length === 1);
    // The fresh question's clock is the next deadline.
    const firstSeen = (await database.query<{ first_seen_at: Date }>(
      `SELECT first_seen_at FROM needs_you_marks WHERE message_id=$1`, [fresh],
    )).rows[0]!.first_seen_at;
    expect(next).toBe(new Date(firstSeen).getTime() + 24 * 3600_000);
    await loop.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(expiryWakes()).toHaveLength(1);
  });

  it('sweeps only on the process that holds the background lock', async () => {
    const runOnce = vi.spyOn(NeedsYouExpiryLoop.prototype, 'runOnce');
    const loop = new NeedsYouExpiryLoop(database);
    let released = false;
    const leader = new BackgroundLeader({
      connectDedicated: async () => ({
        query: async <Row>() => ({ rows: [{ locked: false }] as Row[] }),
        release: () => { released = true; },
      }),
    }, async () => { await loop.runOnce(); }, 10);
    const running = leader.run();
    await eventually(() => released);
    leader.stop();
    await running;
    expect(runOnce).not.toHaveBeenCalled();
  });
});
