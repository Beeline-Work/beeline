import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { cornerIdleSql, currentIdleReportSql } from './corner-idle.js';
import { needsYouItems } from './needs-you.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { LiveHub } from './live.js';
import { announceAgentLifecycle } from './connection-presence.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Slow-query proofs require isolated loopback PostgreSQL');
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-000000000000';
const corner = '22222222-2222-4222-8222-000000000001';
const archived = '22222222-2222-4222-8222-000000001000';
const human = '1'.repeat(64), agent = '2'.repeat(64);

type Plan = { 'Execution Time': number; 'Planning Time': number; Plan: PlanNode;
  Triggers?: { 'Trigger Name': string; Time: number }[] };
type PlanNode = { 'Relation Name'?: string; 'Node Type': string; 'Actual Loops': number; Plans?: PlanNode[] };
function executed(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(executed)].filter(item => item['Actual Loops'] > 0);
}

describe.skipIf(!url)('production-shaped slow-query regression', () => {
  it('keeps live/archived idle, report delivery, tray and writes below one second with 1,895 Rooms and 416,880 messages', async () => {
    const schema = `slow_queries_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c jit=off -c search_path=${schema},public`, max: 1 };
    const database = new PostgresDatabase('', 1, { pool: new Pool(config), mode: 'migration' });
    const writer = new Pool(config), reader = new Pool(config);
    let announcing: Promise<void> | undefined;
    try {
      await migrate(database);
      await writer.query(await readFile(new URL('../proofs/slow-query-fixture.sql', import.meta.url), 'utf8'));
      expect(Number((await writer.query('SELECT count(*) count FROM rooms')).rows[0].count)).toBe(1895);
      expect(Number((await writer.query('SELECT count(*) count FROM messages')).rows[0].count)).toBe(416880);
      const explain = async (name: string, sql: string, values: unknown[] = []): Promise<Plan> => {
        const result = await writer.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values);
        const plan = result.rows[0]['QUERY PLAN'][0] as Plan;
        console.log(JSON.stringify({ name, fingerprint: createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16),
          planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], triggers: plan.Triggers }));
        expect(plan['Execution Time'] + plan['Planning Time'], name).toBeLessThan(1000);
        return plan;
      };
      await explain('live idle', cornerIdleSql('$1'), [corner]);
      const closed = await explain('archived idle', cornerIdleSql('$1'), [archived]);
      expect(executed(closed.Plan).filter(node => ['messages', 'agent_turns'].includes(node['Relation Name'] ?? ''))).toEqual([]);
      await explain('idle report fence', `SELECT ${currentIdleReportSql('command')}
        FROM (SELECT $1::jsonb private_payload) command`, [JSON.stringify({ originCornerId: corner, idleSince: '0' })]);
      const capture: SqlDatabase = {
        query: async (sql, values) => { await explain('viewer_rooms tray', sql, values); return { rows: [], rowCount: 0 }; },
        transaction: work => work(capture),
      };
      // Capture the exact phone SQL after inherited-membership rewriting.
      await expect(needsYouItems(new CornerAccessDatabase(capture), workspace, human, () => { throw new Error('EXPLAIN only'); }, false))
        .rejects.toThrow('workspace membership required');
      await writer.query('BEGIN');
      const insert = await explain('message insert with live report triggers', `INSERT INTO messages(id,room_id,author_id,text)
        VALUES(repeat('f',64),$1,repeat('3',64),'Proceed with the reports')`, [room]);
      expect(insert.Triggers?.find(trigger => trigger['Trigger Name'] === 'corner_report_answer')?.Time).toBeLessThan(200);
      await writer.query('ROLLBACK');
      await writer.query('BEGIN');
      await explain('presence update 873e78181a07fa61', `UPDATE live_outputs SET body=$3::jsonb,updated_at=clock_timestamp()
       WHERE room_id=$1 AND agent_id=$2 AND turn_id='presence' AND kind='presence'`, [room, agent, '{}']);
      await explain('connection last use', `UPDATE rooms_mcp_connections SET last_used_at=now() WHERE client_id=$1 AND identity_id=$2 AND revoked_at IS NULL`, ['slow-query-proof', human]);
      await explain('advisory lock 4c93380abebe4682', 'SELECT pg_advisory_xact_lock(hashtext($1))', ['slow-query-proof']);
      await writer.query('ROLLBACK');

      // A restart receipt can wait on its command row, but it must release
      // presence and its advisory lock before completing that durable work.
      await database.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
        root_command_id,root_source_message_id,agent_depth,state,lifecycle_before)
        VALUES('restart-proof',$1,$2,'restart-proof','restart','tagged_lifecycle_restart',
          'restart-proof','restart-proof',0,'claimed','old-lifecycle')`, [room, agent]);
      const pid = (await database.query<{pid: number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      await writer.query('BEGIN');
      await writer.query("SELECT id FROM agent_commands WHERE id='restart-proof' FOR UPDATE");
      announcing = announceAgentLifecycle(database, new LiveHub(), room, agent, {lifecycleId: 'new-lifecycle'});
      void announcing.catch(() => {});
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        blocked = (await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(done => setTimeout(done, 5));
      }
      expect(blocked, 'restart receipt reached its command-row wait').toBe(true);
      expect((await reader.query(`SELECT body->>'lifecycleId' lifecycle FROM live_outputs
        WHERE agent_id=$1 AND kind='presence'`, [agent])).rows[0].lifecycle).toBe('new-lifecycle');
      const presenceStarted = performance.now();
      await reader.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`presence:${agent}`]);
      await reader.query(`UPDATE live_outputs SET body=$3::jsonb,updated_at=clock_timestamp()
       WHERE room_id=$1 AND agent_id=$2 AND turn_id='presence' AND kind='presence'`, [room, agent, '{"lifecycleId":"new-lifecycle"}']);
      await reader.query(`UPDATE rooms_mcp_connections SET last_used_at=now()
        WHERE client_id=$1 AND identity_id=$2 AND revoked_at IS NULL`, ['slow-query-proof', human]);
      // MCP retention DELETEs also acquire the shared authority lock in their
      // BEFORE triggers, matching the background-deadlines.js retention frame.
      await reader.query(`INSERT INTO rooms_mcp_families(id,client_id,identity_id,scope,revoked_at)
        VALUES('expired-proof','slow-query-proof',$1,'rooms:read',now()-interval '31 days')`, [human]);
      await reader.query(`DELETE FROM rooms_mcp_families WHERE ctid IN (
        SELECT ctid FROM rooms_mcp_families WHERE revoked_at+interval '30 days'<=clock_timestamp()
        LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
      expect(performance.now() - presenceStarted).toBeLessThan(1000);
      await writer.query('ROLLBACK');
      await announcing;

    } finally {
      await writer.query('ROLLBACK');
      await announcing?.catch(() => {});
      await Promise.all([writer.end(), reader.end(), database.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 300_000);
});
