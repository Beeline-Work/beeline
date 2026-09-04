import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { TokenAuth } from './auth.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const SCHEDULE = '44444444-4444-4444-8444-444444444444';
const GRANT = '55555555-5555-4555-8555-555555555555';
const PENDING_GRANT = '66666666-6666-4666-8666-666666666666';
const CODE = '1234ABCD-5678EF90';

/**
 * Removal RETIRES an agent: presence, authority and configuration end, and
 * nothing keeps firing on its behalf — while every turn and message it
 * authored stays exactly where it is.
 */
describe('PhoneService agent removal', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,face_id) VALUES($1,'human','Owner',NULL),($2,'agent','Foxy','fox')`,
      [OWNER, AGENT],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog,commands,schedule_ids,yolo_mode,yolo_set_by,yolo_set_at)
       VALUES($1,$2,$3::jsonb,'gpt-5.6-codex','high','[{"category":"model"}]'::jsonb,'["npm test"]'::jsonb,$4::jsonb,true,$2,now())`,
      [AGENT, OWNER, JSON.stringify({ name: 'Foxy', instructions: 'Be sly.' }), JSON.stringify([SCHEDULE])],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`,
      [CORNER, WORKSPACE, ROOM],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle)
       VALUES($1,$2,'ship the thing','{"lifecycle":"working","checks":"unknown"}'::jsonb)`,
      [CORNER, AGENT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member'),($1,$5,$3,'member')`,
      [WORKSPACE, OWNER, AGENT, ROOM, CORNER],
    );
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
       VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":60}'::jsonb,'stand up',now() - interval '1 minute')`,
      [SCHEDULE, WORKSPACE, ROOM, AGENT, OWNER],
    );
    await database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
       VALUES($1,$2,$3,'command','npm test','run the suite',$2,$4,'approved'),
             ($5,$2,$3,'command','npm run deploy','ship it',$2,$4,'pending')`,
      [GRANT, AGENT, WORKSPACE, ROOM, PENDING_GRANT],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'Foxy asks Owner','card','grant-request',$4::jsonb)`,
      [
        'd'.repeat(64),
        ROOM,
        AGENT,
        JSON.stringify({
          grants: [
            {
              grantId: PENDING_GRANT,
              kind: 'command',
              target: 'npm run deploy',
              reason: 'ship it',
              status: 'pending',
              requestedBy: { pubkey: AGENT, kind: 'agent', name: 'Foxy' },
              roomId: ROOM,
              createdAt: 1_756_900_000,
              auto: false,
            },
          ],
        }),
      ],
    );
    await database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'req-1',$2,'complete')`,
      [ROOM, AGENT],
    );
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      'c'.repeat(64),
      ROOM,
      AGENT,
      'on it',
    ]);
    await database.query(
      `INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`,
      [createHash('sha256').update('token').digest('hex'), AGENT],
    );
    phone = new PhoneService(database, 'https://server.example');
  });

  afterEach(async () => database.close());

  const remove = () =>
    phone.execute('removeAgent', { workspaceId: WORKSPACE, agentId: AGENT }, OWNER);

  it('hides the identity and retires the configuration while the record of the work stays', async () => {
    await remove();

    const identity = (
      await database.query<{ hidden_from_roster: boolean }>(
        `SELECT hidden_from_roster FROM identities WHERE id=$1`,
        [AGENT],
      )
    ).rows[0];
    expect(identity).toEqual({ hidden_from_roster: true });

    const config = (
      await database.query<{
        soul: unknown;
        selected_model: string | null;
        selected_effort: string | null;
        model_catalog: unknown;
        commands: unknown;
        schedule_ids: unknown;
        yolo_mode: boolean;
        yolo_set_by: string | null;
        yolo_set_at: Date | null;
        owner_id: string;
      }>(
        `SELECT soul,selected_model,selected_effort,model_catalog,commands,schedule_ids,
                yolo_mode,yolo_set_by,yolo_set_at,owner_id FROM agents WHERE agent_id=$1`,
        [AGENT],
      )
    ).rows[0];
    expect(config).toEqual({
      soul: null,
      selected_model: null,
      selected_effort: null,
      model_catalog: [],
      commands: [],
      schedule_ids: [],
      yolo_mode: false,
      yolo_set_by: null,
      yolo_set_at: null,
      // The row itself survives: it is what still answers "who connected this".
      owner_id: OWNER,
    });

    // What the agent did is not erased.
    expect(
      (await database.query(`SELECT 1 FROM agent_turns WHERE agent_id=$1`, [AGENT])).rowCount,
    ).toBe(1);
    expect(
      (await database.query(`SELECT 1 FROM messages WHERE author_id=$1 AND text='on it'`, [AGENT]))
        .rowCount,
    ).toBe(1);
  });

  it('draws the agent in no roster and no picker once it is removed', async () => {
    const before = await phone.readWorkspace(WORKSPACE, OWNER);
    expect(before?.agents.map((member) => member.identity.pubkey)).toEqual([AGENT]);

    await remove();

    const workspace = await phone.readWorkspace(WORKSPACE, OWNER);
    expect(workspace?.agents).toEqual([]);
    const room = await phone.readRoom(ROOM, OWNER);
    expect(room?.members.map((member) => member.identity.pubkey)).toEqual([OWNER]);
    expect(await phone.readAgent(WORKSPACE, AGENT, OWNER)).toBeNull();
  });

  it('stops the schedules and revokes the outstanding grants', async () => {
    await remove();

    expect((await database.query(`SELECT 1 FROM agent_schedules WHERE agent_id=$1`, [AGENT])).rowCount).toBe(0);
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(0);

    const grants = (
      await database.query<{ id: string; status: string; decided_by: string | null }>(
        `SELECT id,status,decided_by FROM agent_grants WHERE agent_id=$1 ORDER BY target`,
        [AGENT],
      )
    ).rows;
    expect(grants).toEqual([
      { id: PENDING_GRANT, status: 'revoked', decided_by: OWNER },
      { id: GRANT, status: 'revoked', decided_by: OWNER },
    ]);

    // The card the Room already shows stops offering a choice nobody can take.
    const card = (
      await database.query<{ card: { grants: { status: string }[] } }>(
        `SELECT card FROM messages WHERE card_type='grant-request'`,
      )
    ).rows[0];
    expect(card?.card.grants[0]).toMatchObject({ status: 'revoked' });
  });

  it('archives the corner the removed agent owned, keeping its transcript', async () => {
    await remove();

    const corner = (
      await database.query<{ archived: boolean }>(
        `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
        [CORNER],
      )
    ).rows[0];
    expect(corner).toEqual({ archived: true });
    const facts = (
      await database.query<{ close_requested: boolean; lifecycle: Record<string, unknown> }>(
        `SELECT close_requested,lifecycle FROM corner_facts WHERE corner_id=$1`,
        [CORNER],
      )
    ).rows[0];
    expect(facts?.close_requested).toBe(true);
    expect(facts?.lifecycle).toMatchObject({
      lifecycle: 'done',
      outcome: 'abandoned',
      reason: 'Foxy was removed',
    });
  });

  it('revokes the daemon tokens and answers that agent definitively as removed', async () => {
    const auth = new TokenAuth(database, async () => {
      throw new Error('unused');
    });
    expect(await auth.retiredDaemonAgent('token')).toBeNull();

    await remove();

    expect(
      (
        await database.query(`SELECT 1 FROM daemon_tokens WHERE agent_id=$1 AND revoked_at IS NULL`, [
          AGENT,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await auth.authenticateDaemon('token')).toBeNull();
    expect(await auth.retiredDaemonAgent('token')).toBe(AGENT);
    // A token nobody issued is never a removal answer.
    expect(await auth.retiredDaemonAgent('some-other-token')).toBeNull();
  });

  it('keeps a revoked token ambiguous while the agent still holds a membership', async () => {
    const auth = new TokenAuth(database, async () => {
      throw new Error('unused');
    });
    await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [AGENT]);
    expect(await auth.retiredDaemonAgent('token')).toBeNull();
  });

  it('gives the same key a clean, freshly seeded agent when it pairs again', async () => {
    await remove();
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at)
       VALUES($1,$2,$3,now() + interval '15 minutes')`,
      [createHash('sha256').update(CODE).digest('hex'), WORKSPACE, OWNER],
    );

    const claim = await phone.claimAgentConnectPairing({
      code: CODE,
      agentPubkey: AGENT,
      model: 'claude-opus-5',
    });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') return;

    const identity = (
      await database.query<{ name: string; face_id: string; hidden_from_roster: boolean }>(
        `SELECT name,face_id,hidden_from_roster FROM identities WHERE id=$1`,
        [AGENT],
      )
    ).rows[0];
    expect(identity).toEqual({
      name: claim.agentName,
      face_id: claim.face,
      hidden_from_roster: false,
    });

    const config = (
      await database.query<{
        soul: { name?: string; instructions?: string } | null;
        selected_model: string | null;
        selected_effort: string | null;
        model_catalog: unknown;
        commands: unknown;
        schedule_ids: unknown;
        yolo_mode: boolean;
        yolo_set_by: string | null;
      }>(
        `SELECT soul,selected_model,selected_effort,model_catalog,commands,schedule_ids,yolo_mode,yolo_set_by
         FROM agents WHERE agent_id=$1`,
        [AGENT],
      )
    ).rows[0];
    expect(config?.soul?.instructions).toBe(claim.soul);
    expect(config?.soul?.instructions).not.toBe('Be sly.');
    expect(config).toMatchObject({
      selected_model: 'claude-opus-5',
      selected_effort: null,
      model_catalog: [],
      commands: [],
      schedule_ids: [],
      yolo_mode: false,
      yolo_set_by: null,
    });

    const workspace = await phone.readWorkspace(WORKSPACE, OWNER);
    expect(workspace?.agents.map((member) => member.identity.name)).toEqual([claim.agentName]);
  });

  it('never overwrites a person with an agent pairing on the same key', async () => {
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at)
       VALUES($1,$2,$3,now() + interval '15 minutes')`,
      [createHash('sha256').update(CODE).digest('hex'), WORKSPACE, OWNER],
    );
    await expect(
      phone.claimAgentConnectPairing({ code: CODE, agentPubkey: OWNER, model: 'claude-opus-5' }),
    ).rejects.toThrow('pairing key belongs to a person');
  });
});
