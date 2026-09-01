import { describe, expect, it } from 'vitest';
import {
  BackgroundLeader,
  PushDeliveryLoop,
  runMaintenance,
  type LeaderConnection,
} from './background.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';

describe('background advisory-lock ownership', () => {
  it('releases and reconnects after its dedicated connection health check fails', async () => {
    let connections = 0;
    let released = false;
    let cycles = 0;
    const connectDedicated = async (): Promise<LeaderConnection> => {
      connections += 1;
      const connection = connections;
      return {
        query: async <Row>(sql: string) => {
          if (sql === 'SELECT 1' && connection === 1) throw new Error('connection died');
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] as Row[] };
          return { rows: [{} as Row] };
        },
        release: (destroy) => {
          if (connection === 1 && destroy) released = true;
        },
      };
    };
    const leader = new BackgroundLeader(
      { connectDedicated },
      async () => {
        cycles += 1;
      },
      1,
    );
    const running = leader.run();

    await until(() => cycles > 0);
    leader.stop();
    await running;

    expect(connections).toBeGreaterThanOrEqual(2);
    expect(released).toBe(true);
  });

  it('moves work to the peer after the lock-holder connection dies', async () => {
    const lock = new FakeAdvisoryLock();
    let first = 0;
    let second = 0;
    const leaderA = new BackgroundLeader(
      { connectDedicated: () => lock.connect('a') },
      async () => {
        first += 1;
      },
      5,
    );
    const leaderB = new BackgroundLeader(
      { connectDedicated: () => lock.connect('b') },
      async () => {
        second += 1;
      },
      5,
    );
    const runningA = leaderA.run();
    const runningB = leaderB.run();
    await until(() => first > 1);
    expect(second).toBe(0);
    lock.killOwner();
    leaderA.stop();
    await until(() => second > 1);
    leaderB.stop();
    await Promise.all([runningA, runningB]);
    expect(first).toBeGreaterThan(1);
    expect(second).toBeGreaterThan(1);
  });
  it('persists an FCM failure without claiming a successful delivery', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('device-token-12345678901234567890',$1,'ios','physical')`,
        [agent],
      );
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'hello')`, [
        '1'.repeat(64),
        room,
        human,
      ]);
      const loop = new PushDeliveryLoop(db, {
        send: async () => {
          throw new Error('FCM unavailable');
        },
      });
      expect(await loop.runOnce()).toBe(0);
      expect(
        (
          await db.query<{ status: string; error: string }>(
            `SELECT status,error FROM push_delivery_claims`,
          )
        ).rows[0],
      ).toEqual({ status: 'failed', error: 'FCM unavailable' });
    } finally {
      await db.close();
    }
  });
  it('retains imported historical presence while expiring ordinary live output', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
         VALUES($1,$2,'legacy','presence','{"status":"online","observedAt":1}',to_timestamp(1)),
               ($1,$2,'expired-turn','draft','{}',to_timestamp(1))`,
        [room, agent],
      );
      await runMaintenance(db);
      expect(
        (await db.query<{ turn_id: string }>(`SELECT turn_id FROM live_outputs`)).rows,
      ).toEqual([{ turn_id: 'legacy' }]);
    } finally {
      await db.close();
    }
  });
});

class FakeAdvisoryLock {
  owner: string | undefined;
  dead = new Set<string>();
  sequence = 0;
  async connect(process: string): Promise<LeaderConnection> {
    const id = `${process}-${++this.sequence}`;
    return {
      query: async <Row>(sql: string) => {
        if (this.dead.has(id)) throw new Error('connection died');
        if (sql.includes('pg_try_advisory_lock')) {
          const locked = !this.owner || this.owner === id;
          if (locked) this.owner = id;
          return { rows: [{ locked }] as Row[] };
        }
        return { rows: [{} as Row] };
      },
      release: () => {
        if (this.owner === id) this.owner = undefined;
      },
    };
  }
  killOwner() {
    if (this.owner) this.dead.add(this.owner);
  }
}
async function until(check: () => boolean) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
