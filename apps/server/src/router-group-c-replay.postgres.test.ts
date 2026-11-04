import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { RouterSnapshotInput, RouterValues } from '@beeline/api-contract/router-protocol';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from './router-projection-schema.js';
import { RouterBuildCoordinator } from './router-build-coordinator.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { routerSocketProtocol } from './router-socket.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Group C replay proofs require isolated loopback PostgreSQL');
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222', viewer = 'synthetic-reader';
const input: RouterSnapshotInput = { family: 'room-list', workspaceId: workspace };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// This isolates the real protocol/coordinator/drain/authority cost. The narrow
// fixture builder is explicitly synthetic, so neither its CPU nor its query
// counts establish whole-PhoneService or production workload non-regression.
describe.skipIf(!url)('Group C P5/P6/P11 two-pool replay sharing', () => {
  it('F13: sixteen readers per server share one base build per cut; both real LISTEN owners deliver the committed replacement without WAL writes', async () => {
    const schema = `group_c_replay_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 4 };
    const databases = [new PostgresDatabase('', 4, { pool: new Pool(config) }), new PostgresDatabase('', 4, { pool: new Pool(config) })];
    const listeners: Client[] = [], protocols: ReturnType<typeof routerSocketProtocol>[] = [];
    const coordinators = [new RouterBuildCoordinator(), new RouterBuildCoordinator()];
    const builds = [0, 0], statements = [0, 0], frames: Record<string, any>[][] = [];
    const committed: Promise<void>[] = [], errors: unknown[] = [];
    const basis = { schema: 1 as const, databaseScope: schema, version: 'synthetic-room-list-v1', publicOrigin: 'https://synthetic.test', clockVersion: 'no-clock-dependencies' };
    try {
      const db = databases[0]!;
      await db.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz,name text);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA); await db.query(ROUTER_PROJECTION_SCHEMA);
      await db.query('INSERT INTO workspaces VALUES($1)', [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Before')`, [room, workspace]);
      await db.query(`INSERT INTO memberships VALUES($1,NULL,$3,'member',NULL),($1,$2,$3,'member',NULL)`, [workspace, room, viewer]);
      for (let server = 0; server < 2; server++) {
        const database = databases[server]!, live = new LiveHub();
        const wrap = (value: SqlDatabase): SqlDatabase => ({
          query: async (sql, args) => { statements[server]!++; return value.query(sql, args); },
          transaction: work => value.transaction(tx => work(wrap(tx))),
        });
        const observed = wrap(database), phone = new PhoneService(observed, 'https://synthetic.test');
        phone.buildRouterValue = async tx => {
          builds[server]!++;
          const rows = (await tx.query<{ id: string; name: string }>('SELECT id,name FROM rooms WHERE workspace_id=$1 ORDER BY id', [workspace])).rows;
          return { workspace: { id: workspace, name: 'Synthetic' }, chats: rows, viewer: { pubkey: viewer, name: 'Reader' }, truncated: false, watchFilters: [] } as unknown as RouterValues['room-list'];
        };
        const listener = new Client(config); listeners.push(listener);
        listener.on('notification', event => {
          if (event.channel === 'beeline_live_v1' && event.payload) {
            const streams = JSON.parse(event.payload).journalStreams;
            if (Array.isArray(streams)) live.journalChanged(streams);
          }
        });
        await listener.connect(); await listener.query('LISTEN beeline_live_v1');
        for (let n = 0; n < 16; n++) {
          const output: Record<string, any>[] = [], done = deferred(); frames.push(output); committed.push(done.promise);
          const protocol = routerSocketProtocol(observed, viewer, raw => {
            const frame = JSON.parse(raw); output.push(frame);
            if (frame.kind === 'push-commit') done.resolve();
            if (frame.kind === 'router-unavailable') errors.push(frame);
          }, { families: ['room-list'], listenerReady: () => true, sharedBuilds: { coordinator: coordinators[server]!, basis } },
          { live, phone, rooms: () => [] });
          protocols.push(protocol);
          await protocol.handle({ type: 'router-negotiate', protocol: 1, families: ['room-list'] });
        }
      }
      const before = (await admin.query('SELECT pg_current_wal_insert_lsn()::text position')).rows[0]!.position;
      const snapshots = await Promise.all(protocols.map(protocol => protocol.snapshot(input)));
      const after = (await admin.query('SELECT pg_current_wal_insert_lsn()::text position')).rows[0]!.position;
      expect(after).toBe(before); expect(builds).toEqual([1, 1]);
      expect(snapshots.every(snapshot => JSON.stringify(snapshot) === JSON.stringify(snapshots[0]))).toBe(true);
      const baselineStatements = [...statements];
      await db.transaction(async tx => {
        await tx.query(`UPDATE rooms SET name='After' WHERE id=$1`, [room]);
        await tx.query(`SELECT beeline_journal($1,'{"sourceTable":"rooms","operation":"UPDATE"}'::jsonb)`, [`workspace:${workspace}`]);
        await tx.query(`SELECT pg_notify('beeline_live_v1',json_build_object('journalStreams',ARRAY[$1::text])::text)`, [`workspace:${workspace}`]);
      });
      // Capture WAL after the writer's actual effect/cause. Pure fanout must
      // add no WAL of its own, irrespective of reader count.
      const writerCut = (await admin.query('SELECT pg_current_wal_insert_lsn()::text position')).rows[0]!.position;
      await Promise.all(committed);
      const deliveredCut = (await admin.query('SELECT pg_current_wal_insert_lsn()::text position')).rows[0]!.position;
      expect(deliveredCut).toBe(writerCut); expect(builds).toEqual([2, 2]); expect(errors).toEqual([]);
      for (const output of frames) {
        const parts = output.filter(frame => frame.kind === 'push-part');
        expect(parts).toHaveLength(1); expect(output.filter(frame => frame.kind === 'push-commit')).toHaveLength(1);
        expect(parts[0]!.facts[0].payload).toMatchObject({ kind: 'scope-replace', family: 'room-list', value: { chats: [{ name: 'After' }] } });
        expect(Buffer.byteLength(JSON.stringify(parts[0]))).toBeLessThanOrEqual(64 * 1024);
      }
      const current = await Promise.all(protocols.map(protocol => protocol.snapshot(input)));
      expect(current.every(snapshot => JSON.stringify(snapshot) === JSON.stringify(current[0]))).toBe(true);
      expect(current[0]!.cut.through).toBe(snapshots[0]!.cut.through + 1);
      expect(builds).toEqual([2, 2]);
      console.log('GROUP_C_REPLAY', JSON.stringify({ servers: 2, readersPerServer: 16, initialBaseBuilds: [1, 1], committedBaseBuilds: [1, 1],
        initialStatements: baselineStatements, totalStatements: statements, readOnlyWalBytes: 0, syntheticBuilder: true }));
    } finally {
      for (const protocol of protocols) protocol.close();
      await Promise.all(listeners.map(listener => listener.end())); await Promise.all(databases.map(db => db.close()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 20_000);
});
