import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import {
  WELCOME_RETIREMENT_STEP,
  WelcomeRetirementRefusedError,
  retireWelcomeWorkspace,
  welcomeRetirementPreflight,
} from './welcome-retirement.js';

const OWNER = 'a'.repeat(64);
const WELCOME_ONLY = 'b'.repeat(64);
const TWO_HOMES = 'c'.repeat(64);
const GREETER = 'd'.repeat(64);
const STRAY_AGENT = 'e'.repeat(64);
const HOMED_AGENT = 'f'.repeat(64);
const CREW = '11111111-1111-4111-8111-111111111111';
const CREW_ROOM = '22222222-2222-4222-8222-222222222222';
const GREETER_CORNER = '33333333-3333-4333-8333-333333333333';

const count = async (database: PgliteDatabase, sql: string, values: unknown[] = []) =>
  (await database.query(sql, values)).rowCount;

async function seed(database: PgliteDatabase) {
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'human','Solo','solo'),($3,'human','Both','both'),
      ($4,'agent','Greeter','greeter'),($5,'agent','Stray','stray'),($6,'agent','Homed','homed')`,
    [OWNER, WELCOME_ONLY, TWO_HOMES, GREETER, STRAY_AGENT, HOMED_AGENT],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,soul,selected_model) VALUES
      ($1,$4,'{"name":"Greeter"}'::jsonb,'m'),($2,$4,NULL,NULL),($3,$4,NULL,NULL)`,
    [GREETER, STRAY_AGENT, HOMED_AGENT, OWNER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Welcome'),($2,'Crew')`, [
    DEFAULT_WORKSPACE_ID,
    CREW,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,visibility) VALUES
      ($1,$2,'welcome','public'),($3,$4,'crew','public')`,
    [WELCOME_ROOM_ID, DEFAULT_WORKSPACE_ID, CREW_ROOM, CREW],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,visibility) VALUES($1,$2,$3,'greeter corner','public')`,
    [GREETER_CORNER, CREW, CREW_ROOM],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective) VALUES($1,$2,'keep this open')`,
    [GREETER_CORNER, GREETER],
  );
  for (const identity of [OWNER, WELCOME_ONLY, TWO_HOMES, GREETER, STRAY_AGENT, HOMED_AGENT]) {
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [DEFAULT_WORKSPACE_ID, identity, identity === OWNER ? 'owner' : 'member', WELCOME_ROOM_ID],
    );
  }
  for (const identity of [OWNER, TWO_HOMES, HOMED_AGENT, GREETER]) {
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [CREW, identity, CREW_ROOM],
    );
  }
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES
      ('m-welcome',$1,$2,'hello newcomer'),('m-crew',$3,$2,'hello crew')`,
    [WELCOME_ROOM_ID, GREETER, CREW_ROOM],
  );
  await database.query(
    `INSERT INTO daemon_tokens(token_hash,agent_id) VALUES ($1,$2),($3,$4),($5,$6)`,
    ['1'.repeat(64), GREETER, '2'.repeat(64), STRAY_AGENT, '3'.repeat(64), HOMED_AGENT],
  );
  await database.query(
    `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,'{"type":"daily"}'::jsonb,'greet',now())`,
    [DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID, GREETER, OWNER],
  );
}

describe('Welcome Workspace retirement', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await seed(database);
  });
  afterEach(() => database.close());

  it('retires the exact Greeter and deletes Welcome in one step, keeping history elsewhere', async () => {
    const preflight = await welcomeRetirementPreflight(database);
    expect(preflight).toMatchObject({
      workspace: { id: DEFAULT_WORKSPACE_ID, name: 'Beeline Welcome' },
      marker: null,
      activeMembers: 6,
      activePeople: 3,
      peopleWithNoOtherWorkspace: 1,
      welcomeRoomPresent: true,
    });
    expect(preflight.agents?.map((agent) => agent.agent_id)).toEqual([GREETER, HOMED_AGENT, STRAY_AGENT]);
    // The preflight reads only.
    expect(await count(database, `SELECT 1 FROM beeline_release_steps`)).toBe(0);

    const result = await retireWelcomeWorkspace(database, { greeterAgentId: GREETER });
    expect(result).toEqual({
      status: 'retired',
      greeterAgentId: GREETER,
      members: 6,
      welcomeOnlyPeople: 1,
    });

    // The Workspace, its Room and every membership in it are gone.
    expect(await count(database, `SELECT 1 FROM workspaces WHERE id=$1`, [DEFAULT_WORKSPACE_ID])).toBe(0);
    expect(await count(database, `SELECT 1 FROM rooms WHERE id=$1`, [WELCOME_ROOM_ID])).toBe(0);
    expect(
      await count(database, `SELECT 1 FROM memberships WHERE workspace_id=$1`, [DEFAULT_WORKSPACE_ID]),
    ).toBe(0);
    // People keep their identities; the one with another Workspace keeps it.
    expect(
      await count(database, `SELECT 1 FROM identities WHERE id=ANY($1)`, [[OWNER, WELCOME_ONLY, TWO_HOMES]]),
    ).toBe(3);
    expect(
      await count(
        database,
        `SELECT 1 FROM memberships WHERE identity_id=$1 AND workspace_id=$2 AND removed_at IS NULL`,
        [TWO_HOMES, CREW],
      ),
    ).toBe(2);

    // The Greeter is retired with removeAgent's effects, not erased.
    const greeter = (
      await database.query<{ hidden_from_roster: boolean; soul: unknown; selected_model: unknown }>(
        `SELECT i.hidden_from_roster,a.soul,a.selected_model FROM identities i JOIN agents a ON a.agent_id=i.id WHERE i.id=$1`,
        [GREETER],
      )
    ).rows;
    expect(greeter).toEqual([{ hidden_from_roster: true, soul: null, selected_model: null }]);
    expect(
      await count(database, `SELECT 1 FROM daemon_tokens WHERE agent_id=$1 AND revoked_at IS NULL`, [GREETER]),
    ).toBe(0);
    expect(await count(database, `SELECT 1 FROM agent_schedules WHERE agent_id=$1`, [GREETER])).toBe(0);
    expect(await count(database, `SELECT 1 FROM messages WHERE id='m-crew'`)).toBe(1);
    expect(
      await count(database, `SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NULL`, [GREETER_CORNER]),
    ).toBe(1);

    // An agent whose only home was Welcome is signed out; one with a home keeps its token.
    expect(
      await count(database, `SELECT 1 FROM daemon_tokens WHERE agent_id=$1 AND revoked_at IS NULL`, [STRAY_AGENT]),
    ).toBe(0);
    expect(
      await count(database, `SELECT 1 FROM daemon_tokens WHERE agent_id=$1 AND revoked_at IS NULL`, [HOMED_AGENT]),
    ).toBe(1);

    // A system-owned audit row and the completion marker survive the cascade.
    expect(
      (
        await database.query(`SELECT workspace_name,deleted_by FROM workspace_deletions WHERE workspace_id=$1`, [
          DEFAULT_WORKSPACE_ID,
        ])
      ).rows,
    ).toEqual([{ workspace_name: 'Beeline Welcome', deleted_by: SYSTEM_IDENTITY_ID }]);
    expect(
      await count(database, `SELECT 1 FROM beeline_release_steps WHERE name=$1`, [WELCOME_RETIREMENT_STEP]),
    ).toBe(1);
    // No owner-delete notices for a system migration.
    expect(await count(database, `SELECT 1 FROM workspace_deletion_notices`)).toBe(0);
  });

  it('is retry-safe and nothing brings Welcome back afterwards', async () => {
    await retireWelcomeWorkspace(database, { greeterAgentId: GREETER });
    const again = await retireWelcomeWorkspace(database, { greeterAgentId: GREETER });
    expect(again.status).toBe('already-complete');

    await migrate(database);
    const auth = new TokenAuth(database, async () => ({ subject: 'newcomer', login: 'newcomer', name: 'New' }));
    const signedIn = await auth.exchangeGitHubOidc('proof');
    await migrate(database);
    expect(await count(database, `SELECT 1 FROM workspaces WHERE id=$1`, [DEFAULT_WORKSPACE_ID])).toBe(0);
    expect(await count(database, `SELECT 1 FROM memberships WHERE identity_id=$1`, [signedIn.identityId])).toBe(0);
    expect(await welcomeRetirementPreflight(database)).toMatchObject({ workspace: null });
  });

  it('records an already-absent Workspace quietly', async () => {
    await database.query(`DELETE FROM workspaces WHERE id=$1`, [DEFAULT_WORKSPACE_ID]);
    expect(await retireWelcomeWorkspace(database, { greeterAgentId: GREETER })).toEqual({ status: 'absent' });
    expect(
      (await retireWelcomeWorkspace(database, { greeterAgentId: GREETER })).status,
    ).toBe('already-complete');
  });

  it.each([
    ['an empty id', ''],
    ['a person', OWNER],
    ['an agent that was never in Welcome', 'f'.repeat(63) + '0'],
    ['"none" while agents are members', 'none'],
  ])('refuses %s and changes nothing', async (_label, greeterAgentId) => {
    await expect(retireWelcomeWorkspace(database, { greeterAgentId })).rejects.toThrow(
      WelcomeRetirementRefusedError,
    );
    expect(await count(database, `SELECT 1 FROM workspaces WHERE id=$1`, [DEFAULT_WORKSPACE_ID])).toBe(1);
    expect(await count(database, `SELECT 1 FROM beeline_release_steps`)).toBe(0);
    expect(
      await count(database, `SELECT 1 FROM identities WHERE id=$1 AND hidden_from_roster`, [GREETER]),
    ).toBe(0);
  });

  it('accepts "none" only when no agent was ever a member', async () => {
    await database.query(
      `DELETE FROM memberships WHERE workspace_id=$1 AND identity_id=ANY($2)`,
      [DEFAULT_WORKSPACE_ID, [GREETER, STRAY_AGENT, HOMED_AGENT]],
    );
    expect(await retireWelcomeWorkspace(database, { greeterAgentId: 'none' })).toMatchObject({
      status: 'retired',
      greeterAgentId: null,
    });
  });

  it('rolls everything back when the delete fails part-way', async () => {
    await database.query(`
      CREATE FUNCTION refuse_welcome_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_welcome_delete BEFORE DELETE ON workspaces
        FOR EACH ROW EXECUTE FUNCTION refuse_welcome_delete();
    `);
    await expect(retireWelcomeWorkspace(database, { greeterAgentId: GREETER })).rejects.toThrow(
      'simulated failure',
    );
    expect(await count(database, `SELECT 1 FROM workspaces WHERE id=$1`, [DEFAULT_WORKSPACE_ID])).toBe(1);
    expect(
      await count(database, `SELECT 1 FROM identities WHERE id=$1 AND hidden_from_roster`, [GREETER]),
    ).toBe(0);
    expect(
      await count(database, `SELECT 1 FROM daemon_tokens WHERE agent_id=$1 AND revoked_at IS NULL`, [GREETER]),
    ).toBe(1);
    expect(await count(database, `SELECT 1 FROM beeline_release_steps`)).toBe(0);
    expect(await count(database, `SELECT 1 FROM workspace_deletions`)).toBe(0);
  });
});
