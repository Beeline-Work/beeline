import { expect, it } from 'vitest';
import { migrate } from './database.js';
import { migratedDatabase, PgliteDatabase } from './test-support.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { BACKGROUND_DUE_SOURCE_SCHEMA } from './background-due-source.js';

it('retires the check-in command trigger even when its private table is already absent', async () => {
  const db = new PgliteDatabase();
  try {
    await db.query(`CREATE TABLE agent_commands(id text PRIMARY KEY,state text);
      CREATE TABLE push_outbox(message_id text);
      CREATE TABLE room_read_marks(message_id text);
      INSERT INTO agent_commands VALUES('ordinary-owner-schedule','pending');
      -- Former background-due-source.ts installed this branch on all commands.
      -- PL/pgSQL does not track this SQL reference as a table dependency.
      CREATE FUNCTION beeline_background_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item jsonb:=to_jsonb(NEW); family text:=TG_ARGV[0];
      BEGIN
        IF family='next-day-checkin' AND TG_TABLE_NAME='agent_commands'
          AND NOT EXISTS(SELECT 1 FROM next_day_checkins
            WHERE command_id=item->>'id' AND measured_at IS NULL) THEN RETURN NULL; END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER beeline_background_source_2 AFTER INSERT OR UPDATE OR DELETE ON agent_commands
        FOR EACH ROW EXECUTE FUNCTION beeline_background_source('next-day-checkin','state');`);
    const claim = () => db.query(`UPDATE agent_commands SET state='claimed' WHERE id='ordinary-owner-schedule'`);
    await expect(claim()).rejects.toThrow('relation "next_day_checkins" does not exist');
    for (let pass = 0; pass < 2; pass++) {
      await db.query(BACKGROUND_DUE_SOURCE_SCHEMA);
      await expect(claim()).resolves.toMatchObject({ rowCount: 1 });
      expect((await db.query(`SELECT state FROM agent_commands`)).rows).toEqual([{ state: 'claimed' }]);
      expect((await db.query(`SELECT to_regclass('next_day_checkins') AS relation`)).rows).toEqual([{ relation: null }]);
      expect((await db.query(`SELECT 1 FROM pg_trigger
        WHERE tgrelid='agent_commands'::regclass AND NOT tgisinternal`)).rows).toEqual([]);
    }
  } finally { await db.close(); }
});

it('R-RELEASE-DDL: an upgrade preserves overlap storage and runs a real owner schedule', async () => {
  const db = await migratedDatabase();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
  try {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Bee')`, [human, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Schedules')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, room, human, agent]);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,max_runs)
      VALUES('33333333-3333-4333-8333-333333333333',$4,$1,$2,$3,'{"kind":"interval","everyMinutes":5}','Run my schedule',now()+interval '1 minute',1)`, [room, agent, human, workspace]);
    await db.query(`ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS workflow_run jsonb;`);
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,workflow_run)
      VALUES('44444444-4444-4444-8444-444444444444',$4,$1,$2,$3,'{"kind":"interval","everyMinutes":5}','Internal workflow timer',now(),'{"runId":"retired","timer":"deadline"}')`, [room, agent, human, workspace]);
    // Emulate an upgrade from the former source/expiry architecture.
    await db.query(`ALTER TABLE identities ADD COLUMN last_app_active_at timestamptz;
      ALTER TABLE identities ADD COLUMN away_warning_at timestamptz;
      ALTER TABLE push_delivery_claims ADD COLUMN next_retry_at timestamptz;
      ALTER TABLE push_outbox ADD COLUMN not_before timestamptz DEFAULT now();
      CREATE TABLE next_day_checkin_candidates(identity_id text);
      CREATE TABLE next_day_checkins(command_id text);
      CREATE TABLE pending_mention_notices(source_message_id text);
      CREATE TABLE push_read_clears(device_token text);
      CREATE TABLE push_outbox_retirements(message_id text);
      CREATE TABLE agent_startup_backoff(agent_id text);
      CREATE OR REPLACE FUNCTION beeline_agent_schedule_due_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME='identities' THEN PERFORM NEW.last_app_active_at;
        ELSIF TG_TABLE_NAME='agent_schedules' THEN PERFORM NEW.workflow_run; END IF;
        RETURN NULL;
      END $$;
      CREATE OR REPLACE FUNCTION beeline_display_deadline_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER beeline_display_deadline AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION beeline_display_deadline_change();`);
    await migrate(db);
    // The old serving/rollback image still reads and writes these relations.
    // Their removal belongs to a later contract release, not this upgrade.
    const overlapTables = ['next_day_checkins', 'next_day_checkin_candidates', 'pending_mention_notices',
      'push_read_clears', 'push_outbox_retirements', 'agent_startup_backoff'];
    expect((await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename=ANY($1::text[])`, [overlapTables])).rows.map(row => row.tablename).sort()).toEqual([...overlapTables].sort());
    expect((await db.query(`SELECT 1 FROM pg_trigger WHERE tgname='beeline_display_deadline'`)).rows).toHaveLength(1);
    await db.query(`INSERT INTO next_day_checkins(command_id) VALUES('old-server-command')`);
    expect((await db.query(`SELECT id FROM agent_schedules WHERE message='Internal workflow timer'`)).rows).toEqual([]);
    expect((await db.query(`SELECT message FROM agent_schedules WHERE id='33333333-3333-4333-8333-333333333333'`)).rows).toEqual([{ message: 'Run my schedule' }]);
    expect(await new AgentScheduleLoop(db).runOnce(new Date(Date.now() + 120_000))).toBe(1);
    expect((await db.query(`SELECT text FROM messages WHERE text='Run my schedule'`)).rows).toHaveLength(1);
    await migrate(db);
    expect((await db.query(`SELECT command_id FROM next_day_checkins`)).rows).toEqual([{ command_id: 'old-server-command' }]);
    expect((await db.query(`SELECT 1 FROM pg_trigger WHERE tgname='beeline_display_deadline'`)).rows).toHaveLength(1);
    expect(await new AgentScheduleLoop(db).runOnce(new Date(Date.now() + 240_000))).toBe(0);
  } finally { await db.close(); }
});
