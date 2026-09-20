import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  WORKSPACE_MEMBER_PAGE_SIZE,
  isChatListView,
  isRoomHistoryView,
  isRoomView,
  type ChatListView,
  type RoomView,
} from '@beeline/api-contract/phone';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import {
  SURFACE_REFRESH_MINIMUM_INTERVAL_MS as SURFACE_REFRESH_FLOOR_MS,
  SurfaceRefreshScheduler,
} from '@beeline/buzz-client';
import { TokenAuth } from './auth.js';
import { migrate } from './database.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import {
  CLIENT_PAGE_LOAD_TARGET_MS,
  LIVE_INTERACTION_TARGET_MS,
  ROUTE_P95_BUDGET_MS,
} from './production-corpus-performance.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';

/**
 * End-to-end latency for the two audit gaps that structural evidence could not
 * close: the 150 ms live interaction target and the 450 ms page-load target.
 *
 * Everything below the client's render call is real — the released HTTP routes,
 * the released WebSocket fanout, `PhoneService` against a seeded corpus, and the
 * same response guards the phone validates with. What is NOT covered: native
 * layout and GPU work on a device, and the cross-machine PostgreSQL LISTEN hop
 * (a reader attached to the writing machine is measured here).
 */
const WORKSPACE = '40000000-0000-4000-8000-000000000001';
const DECK_ROOM_COUNT = 200;
const ROOM_HISTORY_COUNT = 5_000;
const WORKSPACE_MEMBER_COUNT = 500;
const CORNER_COUNT = 40;
const SAMPLE_COUNT = 15;

type Sample = {
  readonly label: string;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly targetMs: number;
};

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? Number.POSITIVE_INFINITY;
}

function summarize(label: string, values: readonly number[], targetMs: number): Sample {
  return {
    label,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    targetMs,
  };
}

function deckRoomId(index: number): string {
  return `41000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** The measured Room is one of the deck's own Rooms, carrying real history. */
const ROOM = deckRoomId(0);

/** One agent in the Workspace, so the agent profile surface can be swept. */
const AGENT = 'a9'.repeat(32);

describe('live interaction and page-load latency (audit gaps P1/F5)', () => {
  const database = new PgliteDatabase();
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let writerToken: string;
  let readerToken: string;
  const reported: Sample[] = [];

  beforeAll(async () => {
    await migrate(database);
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    const auth = new TokenAuth(database, async (proof) => ({
      subject: proof,
      login: proof,
      name: proof,
    }));
    // Both members are minted through the released sign-in exchange, so the
    // tokens on every measured request are ordinary phone tokens.
    writerToken = (await auth.exchangeGitHubOidc('writer')).accessToken;
    readerToken = (await auth.exchangeGitHubOidc('reader')).accessToken;
    const linked = await database.query<{ subject: string; identity_id: string }>(
      `SELECT subject,identity_id FROM identity_external_links WHERE provider='github'`,
    );
    const identityFor = (subject: string) =>
      linked.rows.find((row) => row.subject === subject)!.identity_id;
    const WRITER = identityFor('writer');
    const READER = identityFor('reader');
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Latency')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [WORKSPACE, WRITER, READER],
    );
    // Deck width the API actually serves (`readChats` caps at 200 Rooms), so the
    // deck GET on the interaction path is the real one, not a one-Room stub.
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name)
       SELECT ('41000000-0000-4000-8000-' || lpad(index::text,12,'0'))::uuid,$1,$2,'Room ' || index
       FROM generate_series(0,$3::integer - 1) index`,
      [WORKSPACE, WRITER, DECK_ROOM_COUNT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       SELECT $1,room.id,member.identity_id,'member'
       FROM rooms room CROSS JOIN (VALUES($2),($3)) AS member(identity_id)
       WHERE room.workspace_id=$1`,
      [WORKSPACE, WRITER, READER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT md5(room.id::text) || md5('preview' || room.id::text),
              room.id, $2, 'deck preview', now() - interval '1 hour'
       FROM rooms room WHERE room.workspace_id=$1`,
      [WORKSPACE, WRITER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT md5('history-' || index::text) || md5('line-' || index::text),
              $1, $2, 'history line ' || index,
              now() - (index * interval '1 second')
       FROM generate_series(1,$3::integer) index`,
      [ROOM, WRITER, ROOM_HISTORY_COUNT],
    );
    // Width for the surfaces the audit had not swept: a Workspace roster large
    // enough to matter, and a Room carrying a full corner family.
    await database.query(
      `INSERT INTO identities(id,kind,name,handle)
       SELECT md5('member-' || index::text) || md5('crowd-' || index::text),
              'human', 'Member ' || index, 'member' || index
       FROM generate_series(1,$1::integer) index`,
      [WORKSPACE_MEMBER_COUNT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       SELECT $1,NULL,md5('member-' || index::text) || md5('crowd-' || index::text),'member'
       FROM generate_series(1,$2::integer) index`,
      [WORKSPACE, WORKSPACE_MEMBER_COUNT],
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       SELECT ('42000000-0000-4000-8000-' || lpad(index::text,12,'0'))::uuid,$1,$2,$3,'Corner ' || index
       FROM generate_series(0,$4::integer - 1) index`,
      [WORKSPACE, ROOM, WRITER, CORNER_COUNT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       SELECT $1,room.id,member.identity_id,'member'
       FROM rooms room CROSS JOIN (VALUES($2),($3)) AS member(identity_id)
       WHERE room.parent_id=$4`,
      [WORKSPACE, WRITER, READER, ROOM],
    );
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Sweep Agent','sweepagent')`,
      [AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, WRITER]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, AGENT],
    );
    await database.query(`ANALYZE`);

    const live = new LiveHub();
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined, live);
    const daemon = new DaemonService(database, live);
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon,
      live,
      mediaMaximumBytes: 1024 * 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (phone as unknown as { publicOrigin: string }).publicOrigin = origin;
  }, 300_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
    if (reported.length) {
      console.log(
        [
          '| path | p50 | p95 | target |',
          '|---|---:|---:|---:|',
          ...reported.map(
            (sample) =>
              `| ${sample.label} | ${sample.p50Ms.toFixed(1)}ms | ${sample.p95Ms.toFixed(1)}ms |` +
              ` ${sample.targetMs}ms |`,
          ),
        ].join('\n'),
      );
    }
  });

  /** The phone's own read: bearer fetch, then the released response guard. */
  async function surfaceGet<T>(path: string, guard: (value: unknown) => value is T): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });
    if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
    const value = (await response.json()) as unknown;
    if (!guard(value)) throw new Error(`${path} returned a view the phone would reject`);
    return value;
  }

  async function sendMessage(): Promise<string> {
    const messageId = randomBytes(32).toString('hex');
    const response = await fetch(`${origin}/v1/phone/operations/sendRoomMessage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${writerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roomId: ROOM, messageId, text: `interaction ${messageId}` }),
    });
    if (response.status !== 200) throw new Error(`send failed with ${response.status}`);
    return messageId;
  }

  async function openSocket(roomIds: readonly string[]): Promise<WebSocket> {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, [
      `bearer.${readerToken}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const subscribed = new Set<string>();
    const ready = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as { type?: string; roomId?: string };
        if (event.type === 'subscribed' && event.roomId) {
          subscribed.add(event.roomId);
          if (subscribed.size === roomIds.length) resolve();
        }
      });
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomIds: [...roomIds] }));
    await ready;
    return socket;
  }

  it(`paints an open Room's committed message within ${LIVE_INTERACTION_TARGET_MS} ms end to end`, async () => {
    const socket = await openSocket([ROOM]);
    const elapsed: number[] = [];
    try {
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const painted = new Promise<{ id: string; at: number }>((resolve) => {
          const listener = (raw: WebSocket.RawData) => {
            const event = JSON.parse(String(raw)) as {
              type?: string;
              message?: { id?: string };
            };
            // The reader paints exactly what `reconcileRoomMessageDelta`
            // consumes: a projected row, not a hint it must go read.
            if (event.type !== 'message-delta' || !event.message?.id) return;
            socket.off('message', listener);
            resolve({ id: event.message.id, at: performance.now() });
          };
          socket.on('message', listener);
        });
        const startedAt = performance.now();
        const messageId = await sendMessage();
        const delta = await painted;
        expect(delta.id).toBe(messageId);
        elapsed.push(delta.at - startedAt);
      }
    } finally {
      socket.close();
    }
    const summary = summarize('interaction.open-room', elapsed, LIVE_INTERACTION_TARGET_MS);
    reported.push(summary);
    console.log(JSON.stringify(summary));
    expect(summary.p95Ms).toBeLessThanOrEqual(LIVE_INTERACTION_TARGET_MS);
  }, 300_000);

  /**
   * One deck sample: load the deck the way the Room deck loads it, wait
   * `quietMs`, then have the other member post and stop the clock when the
   * authoritative deck view the phone paints is in hand.
   */
  async function deckSample(socket: WebSocket, quietMs: number): Promise<number> {
    let painted: (() => void) | undefined;
    let failed: ((error: unknown) => void) | undefined;
    const loaded = new Promise<void>((resolve, reject) => {
      painted = resolve;
      failed = reject;
    });
    // The deck's own liveness loop: any live event marks the surface dirty and
    // the scheduler owns when the authoritative GET runs.
    const scheduler = new SurfaceRefreshScheduler<ChatListView>({
      fetch: () => surfaceGet(`/v1/phone/workspaces/${WORKSPACE}/chats`, isChatListView),
      apply: () => painted?.(),
      onError: (error) => failed?.(error),
    });
    const listener = (raw: WebSocket.RawData) => {
      const event = JSON.parse(String(raw)) as { type?: string };
      if (event.type === 'invalidate' || event.type === 'message-delta') scheduler.signal();
    };
    socket.on('message', listener);
    try {
      await scheduler.startAfter(Promise.resolve());
      await loaded;
      if (quietMs > 0) await new Promise((resolve) => setTimeout(resolve, quietMs));
      const refreshed = new Promise<void>((resolve, reject) => {
        painted = resolve;
        failed = reject;
      });
      const startedAt = performance.now();
      await sendMessage();
      await refreshed;
      return performance.now() - startedAt;
    } finally {
      socket.off('message', listener);
      scheduler.dispose();
    }
  }

  function deckRoomIds(): string[] {
    return [ROOM, ...Array.from({ length: DECK_ROOM_COUNT - 1 }, (_, i) => deckRoomId(i + 1))];
  }

  it(`refreshes a quiet ${DECK_ROOM_COUNT}-Room deck within ${LIVE_INTERACTION_TARGET_MS} ms of a write`, async () => {
    const socket = await openSocket(deckRoomIds());
    const elapsed: number[] = [];
    try {
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        elapsed.push(await deckSample(socket, 700));
      }
    } finally {
      socket.close();
    }
    const summary = summarize('interaction.deck-quiet', elapsed, LIVE_INTERACTION_TARGET_MS);
    reported.push(summary);
    console.log(JSON.stringify(summary));
    expect(summary.p95Ms).toBeLessThanOrEqual(LIVE_INTERACTION_TARGET_MS);
  }, 300_000);

  /**
   * The open P1. The deck refreshes on every live event, so in any Workspace
   * with ongoing traffic the next event almost always lands inside the
   * `SurfaceRefreshScheduler` coalescing floor — and the floor, not the work,
   * is what the reader waits for. This locks that cost in as a number: a
   * reader waits the remainder of the floor, not the 150 ms product target.
   */
  it('shows the deck coalescing floor, not the work, as the interaction cost', async () => {
    const socket = await openSocket(deckRoomIds());
    const elapsed: number[] = [];
    try {
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        elapsed.push(await deckSample(socket, 0));
      }
    } finally {
      socket.close();
    }
    const summary = summarize('interaction.deck-in-floor', elapsed, LIVE_INTERACTION_TARGET_MS);
    reported.push(summary);
    console.log(
      JSON.stringify({
        ...summary,
        schedulerFloorMs: SURFACE_REFRESH_FLOOR_MS,
        verdict: 'target missed: the wait is the floor',
      }),
    );
    expect(summary.p95Ms).toBeGreaterThan(LIVE_INTERACTION_TARGET_MS);
    expect(summary.p50Ms).toBeGreaterThanOrEqual(SURFACE_REFRESH_FLOOR_MS * 0.9);
    expect(summary.p95Ms).toBeLessThanOrEqual(
      SURFACE_REFRESH_FLOOR_MS + LIVE_INTERACTION_TARGET_MS,
    );
  }, 300_000);

  it(`loads a cold ${DECK_ROOM_COUNT}-Room deck within ${CLIENT_PAGE_LOAD_TARGET_MS} ms`, async () => {
    const elapsed: number[] = [];
    let view: ChatListView | undefined;
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const startedAt = performance.now();
      view = await surfaceGet(`/v1/phone/workspaces/${WORKSPACE}/chats`, isChatListView);
      elapsed.push(performance.now() - startedAt);
    }
    expect(view?.chats.length).toBe(DECK_ROOM_COUNT);
    const summary = summarize('page-load.deck', elapsed, CLIENT_PAGE_LOAD_TARGET_MS);
    reported.push(summary);
    console.log(JSON.stringify(summary));
    expect(summary.p95Ms).toBeLessThanOrEqual(CLIENT_PAGE_LOAD_TARGET_MS);
  }, 300_000);

  it(`loads a Room with ${ROOM_HISTORY_COUNT} messages within ${CLIENT_PAGE_LOAD_TARGET_MS} ms`, async () => {
    const elapsed: number[] = [];
    let view: RoomView | undefined;
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const startedAt = performance.now();
      view = await surfaceGet(`/v1/phone/rooms/${ROOM}`, isRoomView);
      elapsed.push(performance.now() - startedAt);
    }
    expect(view?.messages.length).toBeGreaterThan(0);
    const summary = summarize('page-load.room', elapsed, CLIENT_PAGE_LOAD_TARGET_MS);
    reported.push(summary);
    console.log(JSON.stringify(summary));
    expect(summary.p95Ms).toBeLessThanOrEqual(CLIENT_PAGE_LOAD_TARGET_MS);
  }, 300_000);

  /**
   * Every phone GET the audit had never timed, swept at the width its own API
   * allows: the Workspace picker and one Workspace's detail, the roster #1502
   * bounded at the query (first page, deep page, and search), one agent's
   * profile, the corner list, and history at both the head and a deep page.
   *
   * Together with the deck and Room page-load tests above, this covers all
   * eight authenticated phone GET routes in `server.ts`.
   */
  it('answers every remaining phone GET surface inside the route budget at width', async () => {
    // A real deep-transcript cursor, so the history page measured second is one
    // the reader actually scrolls to rather than the head page again.
    const head = await surfaceGet(`/v1/phone/rooms/${ROOM}/history`, isRoomHistoryView);
    const cursor = head.nextBefore;
    expect(cursor, 'history must paginate at this width').toBeDefined();
    const deepOffset = WORKSPACE_MEMBER_PAGE_SIZE * 24;

    const surfaces: Array<{ label: string; path: string }> = [
      { label: 'surface.workspaces', path: '/v1/phone/workspaces' },
      { label: 'surface.workspace', path: `/v1/phone/workspaces/${WORKSPACE}` },
      { label: 'surface.members', path: `/v1/phone/workspaces/${WORKSPACE}/members` },
      {
        label: 'surface.members-deep-page',
        path: `/v1/phone/workspaces/${WORKSPACE}/members?offset=${deepOffset}`,
      },
      {
        label: 'surface.members-search',
        path: `/v1/phone/workspaces/${WORKSPACE}/members?q=member1`,
      },
      { label: 'surface.agent', path: `/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}` },
      { label: 'surface.corners', path: `/v1/phone/rooms/${ROOM}/corners` },
      { label: 'surface.history', path: `/v1/phone/rooms/${ROOM}/history` },
      {
        label: 'surface.history-deep-page',
        path:
          `/v1/phone/rooms/${ROOM}/history` +
          `?before=${encodeURIComponent(`${cursor!.createdAt},${cursor!.id}`)}`,
      },
    ];
    for (const surface of surfaces) {
      const elapsed: number[] = [];
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const startedAt = performance.now();
        const response = await fetch(`${origin}${surface.path}`, {
          headers: { authorization: `Bearer ${readerToken}` },
        });
        expect(response.status, surface.path).toBe(200);
        await response.json();
        elapsed.push(performance.now() - startedAt);
      }
      const summary = summarize(surface.label, elapsed, ROUTE_P95_BUDGET_MS);
      reported.push(summary);
      console.log(JSON.stringify(summary));
      expect(summary.p95Ms, surface.label).toBeLessThanOrEqual(ROUTE_P95_BUDGET_MS);
    }
  }, 300_000);
});
