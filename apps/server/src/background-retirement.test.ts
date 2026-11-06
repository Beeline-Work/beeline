import { expect, it } from 'vitest';
import { migrate } from './database.js';
import { migratedDatabase } from './test-support.js';
import { AgentScheduleLoop } from './agent-schedules.js';

it('an upgrade deletes retired deadline state and keeps a real owner schedule', async () => {
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
    expect((await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN
      ('next_day_checkins','next_day_checkin_candidates','pending_mention_notices','push_read_clears','push_outbox_retirements','agent_startup_backoff')`)).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM pg_trigger WHERE tgname='beeline_display_deadline'`)).rows).toEqual([]);
    expect((await db.query(`SELECT id FROM agent_schedules WHERE message='Internal workflow timer'`)).rows).toEqual([]);
    expect((await db.query(`SELECT message FROM agent_schedules WHERE id='33333333-3333-4333-8333-333333333333'`)).rows).toEqual([{ message: 'Run my schedule' }]);
    expect(await new AgentScheduleLoop(db).runOnce(new Date(Date.now() + 120_000))).toBe(1);
    expect((await db.query(`SELECT text FROM messages WHERE text='Run my schedule'`)).rows).toHaveLength(1);
    await migrate(db);
    expect(await new AgentScheduleLoop(db).runOnce(new Date(Date.now() + 240_000))).toBe(0);
  } finally { await db.close(); }
});
