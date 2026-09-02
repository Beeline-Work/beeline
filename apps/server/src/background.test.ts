import { describe, expect, it, vi } from 'vitest';
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
        [human],
      );
      const loop = new PushDeliveryLoop(db, {
        send: async () => {
          throw new Error('FCM unavailable');
        },
      });
      await loop.runOnce();
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,mention_ids) VALUES($1,$2,$3,'hello',$4::jsonb)`, [
        '1'.repeat(64),
        room,
        agent,
        JSON.stringify([human]),
      ]);
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
  it('delivers only new attention events to the addressed human device', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const human = 'a'.repeat(64),
        otherHuman = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        directRoom = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Other'),($3,'agent','Bee')`,
        [human, otherHuman, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,direct_participants)
         VALUES($1,$3,'Room',NULL),($2,$3,'Direct',$4::jsonb)`,
        [room, directRoom, workspace, JSON.stringify([human, agent].sort())],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),
               ($1,$6,$3,'owner'),($1,$6,$5,'member')`,
        [workspace, room, human, otherHuman, agent, directRoom],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ('owner-device-token-12345678901234567890',$1,'ios','physical'),
         ('other-device-token-12345678901234567890',$2,'ios','physical')`,
        [human, otherHuman],
      );
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,mention_ids,created_at)
         VALUES($1,$2,$3,'old mention',$4::jsonb,now()-interval '1 hour')`,
        ['0'.repeat(64), room, agent, JSON.stringify([human])],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,mention_ids,presentation,card_type,card) VALUES
         ($1,$2,$3,'Please review',$4::jsonb,'message',NULL,NULL),
         ($5,$2,$3,'Untargeted', '[]'::jsonb,'message',NULL,NULL),
         ($6,$2,$7,'My own mention',$4::jsonb,'message',NULL,NULL),
         ($8,$2,$3,'', $4::jsonb,'activity',NULL,NULL),
         ($9,$2,$3,'', '[]'::jsonb,'card','daemon-fact',$10::jsonb),
         ($11,$2,$3,'', '[]'::jsonb,'card','daemon-fact',$12::jsonb),
         ($13,$14,$3,'A direct message','[]'::jsonb,'message',NULL,NULL)`,
        [
          '1'.repeat(64), room, agent, JSON.stringify([human]),
          '2'.repeat(64), '3'.repeat(64), human, '4'.repeat(64), '5'.repeat(64),
          JSON.stringify({ type: 'corner-open', cornerId: directRoom, objective: 'Ship push policy' }),
          '6'.repeat(64),
          JSON.stringify({ type: 'corner-complete', cornerId: directRoom, objective: 'Ship push policy', outcome: 'landed' }),
          '7'.repeat(64), directRoom,
        ],
      );
      expect(await loop.runOnce()).toBe(6);
      expect(send).toHaveBeenCalledTimes(6);
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee: Please review' }),
      );
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee opened a corner: Ship push policy' }),
      );
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee merged: Ship push policy' }),
      );
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Bee: A direct message' }),
      );
      expect(send).not.toHaveBeenCalledWith(
        'other-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Untargeted' }),
      );
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
