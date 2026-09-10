import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111119';
const ROOM = '22222222-2222-4222-8222-222222222229';
const VIEWER = 'a'.repeat(64);
const QUERY_DURATION_MS = 170;
const POOL_MAX = 10;

type Span = { sql: string; waitMs: number; durationMs: number };

class RepresentativeDatabase implements SqlDatabase {
  readonly spans: Span[] = [];
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(
    private readonly database: SqlDatabase,
    private readonly maximum = POOL_MAX,
    private readonly queryDurationMs = QUERY_DURATION_MS,
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const queuedAt = performance.now();
    await this.acquire();
    const startedAt = performance.now();
    try {
      await new Promise((resolve) => setTimeout(resolve, this.queryDurationMs));
      const result = await this.database.query<Row>(sql, values);
      this.spans.push({
        sql: sql.trim().split(/\s+/).slice(0, 7).join(' '),
        waitMs: startedAt - queuedAt,
        durationMs: performance.now() - startedAt,
      });
      return result;
    } finally {
      this.release();
    }
  }

  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction((database) =>
      work(new RepresentativeDatabase(database, this.maximum, this.queryDurationMs)),
    );
  }

  private async acquire() {
    if (this.#active < this.maximum) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
  }

  private release() {
    this.#active -= 1;
    this.#waiters.shift()?.();
  }
}

describe('PhoneService.readRoom latency', () => {
  const database = new PgliteDatabase();

  beforeAll(async () => {
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Viewer','viewer')`,
      [VIEWER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Production shape')`, [
      WORKSPACE,
    ]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Busy Room')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [WORKSPACE, VIEWER, ROOM],
    );

    for (let index = 0; index < 30; index += 1) {
      const agent = index.toString(16).padStart(64, '0');
      const corner = `33333333-3333-4333-8333-${index.toString().padStart(12, '0')}`;
      await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`, [
        agent,
        `Agent ${index}`,
        `agent-${index}`,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
        [WORKSPACE, agent, ROOM],
      );
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,$4)`,
        [corner, WORKSPACE, ROOM, `Corner ${index}`],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [WORKSPACE, corner, VIEWER, agent],
      );
    }

    for (let index = 0; index < 180; index += 1) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES($1,$2,$3,$4,now() + $5 * interval '1 millisecond')`,
        [`message-${index.toString().padStart(3, '0')}`, ROOM, VIEWER, `Message ${index}`, index],
      );
    }
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
       SELECT 'historical-activity-' || series,$1,$2,'','activity','[]'::jsonb,
         now() - interval '1 day' - series * interval '1 millisecond'
       FROM generate_series(1,10000) series`,
      [ROOM, '0'.repeat(64)],
    );
    await database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at)
       VALUES($1,'message-179',$2,'working',now())`,
      [ROOM, '0'.repeat(64)],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
       VALUES('current-activity',$1,$2,'','activity','[]'::jsonb,now() + interval '1 second')`,
      [ROOM, '0'.repeat(64)],
    );
  }, 30_000);

  afterAll(async () => database.close());

  it('projects the same production-shaped Room in one database round trip', async () => {
    const representative = new RepresentativeDatabase(database);
    const phone = new PhoneService(representative, 'https://server.usebeeline.app');
    const startedAt = performance.now();
    const view = await phone.readRoom(ROOM, VIEWER);
    const durationMs = performance.now() - startedAt;

    if (process.env.READ_ROOM_TRACE === '1') {
      console.info(
        JSON.stringify({
          durationMs: Math.round(durationMs),
          queryCount: representative.spans.length,
          totalWaitMs: Math.round(
            representative.spans.reduce((total, span) => total + span.waitMs, 0),
          ),
          spans: representative.spans.map((span) => ({
            ...span,
            waitMs: Math.round(span.waitMs),
            durationMs: Math.round(span.durationMs),
          })),
        }),
      );
    }

    expect(view?.messages.length).toBe(30);
    expect(view?.members.length).toBe(31);
    expect(view?.corners.length).toBe(30);
    expect(view?.messages.map((message) => message.id)).toEqual([
      ...Array.from(
        { length: 29 },
        (_, index) => `message-${(151 + index).toString().padStart(3, '0')}`,
      ),
      'current-activity',
    ]);
    expect(new Set(view?.members.map((member) => member.identity.pubkey))).toEqual(
      new Set([
        VIEWER,
        ...Array.from({ length: 30 }, (_, index) => index.toString(16).padStart(64, '0')),
      ]),
    );
    expect(new Set(view?.corners.map((corner) => corner.corner.id))).toEqual(
      new Set(
        Array.from(
          { length: 30 },
          (_, index) => `33333333-3333-4333-8333-${index.toString().padStart(12, '0')}`,
        ),
      ),
    );
    expect(representative.spans).toHaveLength(1);
    expect(durationMs).toBeLessThan(250);
  }, 10_000);

  it('does not restore the serial waterfall at concurrency four', async () => {
    const representative = new RepresentativeDatabase(database);
    const phone = new PhoneService(representative, 'https://server.usebeeline.app');
    const durations = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const startedAt = performance.now();
        await phone.readRoom(ROOM, VIEWER);
        return performance.now() - startedAt;
      }),
    );
    const sorted = durations.toSorted((left, right) => left - right);
    if (process.env.READ_ROOM_TRACE === '1') {
      console.info(
        JSON.stringify({
          concurrency: 4,
          durationsMs: sorted.map((duration) => Math.round(duration)),
        }),
      );
    }
    expect(representative.spans).toHaveLength(4);
    expect(sorted.at(-1)).toBeLessThan(250);
  }, 10_000);

  it('keeps the batched projection behind the Room and Workspace membership gate', async () => {
    const representative = new RepresentativeDatabase(database, POOL_MAX, 0);
    const phone = new PhoneService(representative, 'https://server.usebeeline.app');

    expect(await phone.readRoom(ROOM, 'f'.repeat(64))).toBeNull();
    expect(representative.spans).toHaveLength(2);
  });
});
