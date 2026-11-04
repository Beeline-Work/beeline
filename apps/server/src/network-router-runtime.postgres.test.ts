import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import { migrate, markSchemaCurrent, assertSchemaCurrent, PostgresDatabase } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createNetworkRouterRuntime } from './network-router-runtime.js';
import { routerSocketProtocol } from './router-socket.js';
import { readTrayClockReadiness } from './tray-clock-readiness.js';
const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Activation proof requires loopback PostgreSQL');
afterEach(() => vi.unstubAllEnvs());
describe.skipIf(!url)('production router composition on migrated PostgreSQL', () => {
  it('boots every family without an opt-in and runs Tray on the existing physical leader', async () => {
    const schema = `router_activation_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new PostgresDatabase('', 2, { mode: 'migration', pool: new Pool({ connectionString: url, max: 2,
      options: `-c search_path=${schema},public` }) });
    const live = new LiveHub(), viewer = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
    let ready = true;
    const runtime = createNetworkRouterRuntime({ database: db, jobsDatabase: db, live, instanceId: 'activation-proof',
      publicOrigin: 'https://synthetic.invalid', listenerReady: () => ready, wake: vi.fn(), retireOwner: vi.fn() })!;
    let lock: Awaited<ReturnType<typeof db.connectDedicated>> | undefined;
    let protocol: ReturnType<typeof routerSocketProtocol> | undefined;
    try {
      // Only the real release migration: no private test schema installation.
      await migrate(db, { deferData: true });
      await markSchemaCurrent(db); await assertSchemaCurrent(db);
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Synthetic reader','reader')`, [viewer]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic Workspace')`, [workspace]);
      await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [workspace, viewer]);
      await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('activation-proof')`);
      lock = await db.connectDedicated();
      await lock.query('SELECT pg_advisory_lock($1)', [0x0bee11]);
      await runtime.work.leadership.acquired(lock, new AbortController().signal);
      for (let remaining = 30; remaining > 0; remaining--) { if (await runtime.work.run() !== 0) break; }
      expect(runtime.work.status().state).toBe('live');
      expect((await readTrayClockReadiness(db, workspace))?.ready).toBe(true);
      await runtime.start();
      expect(runtime.policy.trayClockAvailability?.ready()).toBe(true);
      const frames: Record<string, unknown>[] = [];
      protocol = routerSocketProtocol(db, viewer, frame => { frames.push(JSON.parse(frame)); }, runtime.policy,
        { live, phone: new PhoneService(db, 'https://synthetic.invalid'), rooms: () => [], mediaMetadataV1: runtime.mediaMetadataV1 });
      // Old clients never send this frame; no implicit protocol upgrade.
      expect(await protocol.handle({ type: 'subscribe', roomId: 'legacy' })).toBe(false);
      expect(frames).toEqual([]);
      await protocol.handle({ type: 'router-negotiate', protocol: 1, families: ROUTER_FAMILIES,
        authorityFencesV1: true, usageCellV1: true, needsYouRoomsV1: true, scheduledWorkCoverageV1: true, roomHeadContinuityV1: true });
      expect(frames.find(frame => frame.type === 'router-capabilities')).toMatchObject({ families: ROUTER_FAMILIES,
        commandDedupV1: true, mediaMetadataV1: true, authorityFencesV1: true, usageCellV1: true });
      ready = false; live.projectionUnavailable();
      expect(runtime.policy.trayClockAvailability?.ready()).toBe(false);
      expect(runtime.work.status().state).toBe('parked');
    } finally {
      protocol?.close(); await runtime.close(); lock?.release(true); await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 90_000);
});
