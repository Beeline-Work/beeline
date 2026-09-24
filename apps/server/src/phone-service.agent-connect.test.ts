import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FACE_NAMES,
  FACE_SOULS,
  agentHandleFromName,
  defaultFaceForSeed,
  isFaceId,
  type FaceId,
} from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CODE = 'BUZZ-1234ABCD-5678EF90';

describe('PhoneService agent connect pairing claim', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')`,
      [OWNER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Builders')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [WORKSPACE, OWNER, ROOM],
    );
    phone = new PhoneService(database, 'https://server.example');
  });

  afterEach(async () => database.close());

  async function insertCode(expiresAt: Date, claimedBy?: string): Promise<void> {
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at,claimed_by)
       VALUES($1,$2,$3,$4,$5)`,
      [
        createHash('sha256').update(CODE).digest('hex'),
        WORKSPACE,
        OWNER,
        expiresAt,
        claimedBy ?? null,
      ],
    );
  }

  it('mints a prefix-free app pairing code with sixteen bytes of hex text', async () => {
    const before = Math.floor(Date.now() / 1000);
    const pairing = await phone.execute(
      'createAgentPairingCode',
      { workspaceId: WORKSPACE },
      OWNER,
    );
    expect(pairing.code).toMatch(/^[0-9A-F]{8}-[0-9A-F]{8}$/);
    expect(pairing.code).not.toContain('BUZZ-');
    expect(pairing.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60);
    expect(pairing.expiresAt).toBeLessThan(10_000_000_000);
  });

  it('atomically creates and binds the generated agent before returning the grant metadata', async () => {
    await insertCode(new Date(Date.now() + 60_000));

    const claim = await phone.claimAgentConnectPairing({
      code: CODE,
      agentPubkey: AGENT,
      model: 'gpt-5.4',
    });
    expect(claim).toMatchObject({
      status: 'claimed',
      workspaceId: WORKSPACE,
      workspaceName: 'Builders',
      pairedBy: OWNER,
    });
    if (claim.status !== 'claimed') throw new Error('claim failed');
    // Nobody typed a name or a soul: both are seeded from the animal the
    // server picked, and all three name the same creature.
    expect(isFaceId(claim.face)).toBe(true);
    expect(claim.soul).toBe(FACE_SOULS[claim.face as FaceId]);
    expect(FACE_NAMES[claim.face as FaceId]).toContain(claim.agentName);
    const identity = await database.query<{
      name: string;
      handle: string;
      face_id: string;
      owner_id: string;
      selected_model: string;
      soul: { name: string; instructions: string };
    }>(
      `SELECT identity.name,identity.handle,identity.face_id,agent.owner_id,agent.selected_model,agent.soul
       FROM identities identity JOIN agents agent ON agent.agent_id=identity.id
       WHERE identity.id=$1`,
      [AGENT],
    );
    expect(identity.rows).toEqual([
      {
        name: claim.agentName,
        handle: agentHandleFromName(claim.agentName),
        face_id: claim.face,
        owner_id: OWNER,
        selected_model: 'gpt-5.4',
        soul: { name: claim.agentName, instructions: claim.soul, avatarSeed: AGENT },
      },
    ]);
    // The owner already wears a face; the agent never takes it.
    expect(claim.face).not.toBe(defaultFaceForSeed(OWNER));
    // No `deferJoin` (every already-installed CLI): the claim itself joins
    // Rooms immediately, exactly as it always has.
    const memberships = await database.query<{ room_id: string | null }>(
      `SELECT room_id FROM memberships WHERE identity_id=$1 ORDER BY room_id NULLS FIRST`,
      [AGENT],
    );
    expect(memberships.rows).toEqual([{ room_id: null }, { room_id: ROOM }]);
  });

  it('stores the reasoning effort the wizard chose, and none when it asked nothing', async () => {
    const selectedEffort = async (): Promise<string | null> =>
      (
        await database.query<{ selected_effort: string | null }>(
          `SELECT selected_effort FROM agents WHERE agent_id=$1`,
          [AGENT],
        )
      ).rows[0]?.selected_effort ?? null;

    await insertCode(new Date(Date.now() + 60_000));
    await phone.claimAgentConnectPairing({
      code: CODE,
      agentPubkey: AGENT,
      model: 'gpt-5.4',
      effort: 'high',
    });
    expect(await selectedEffort()).toBe('high');

    // Re-pairing the same key starts it over: a claim that asked no effort
    // question leaves the agent on its harness's own, not the last pairing's.
    await database.query(`DELETE FROM agent_pairing_codes WHERE code_hash=$1`, [
      createHash('sha256').update(CODE).digest('hex'),
    ]);
    await insertCode(new Date(Date.now() + 60_000));
    await phone.claimAgentConnectPairing({ code: CODE, agentPubkey: AGENT, model: 'gpt-5.4' });
    expect(await selectedEffort()).toBeNull();
  });

  it('returns a normally connected agent owner from server workspace and profile reads', async () => {
    await insertCode(new Date(Date.now() + 60_000));
    const claim = await phone.claimAgentConnectPairing({
      code: CODE,
      agentPubkey: AGENT,
      model: 'gpt-5.4',
    });
    if (claim.status !== 'claimed') throw new Error('claim failed');

    await expect(phone.readWorkspace(WORKSPACE, OWNER)).resolves.toMatchObject({
      agents: [
        {
          identity: { pubkey: AGENT },
          owner: { pubkey: OWNER, kind: 'human', handle: 'owner' },
        },
      ],
    });
    await expect(phone.readAgent(WORKSPACE, AGENT, OWNER)).resolves.toMatchObject({
      owner: { pubkey: OWNER, kind: 'human', handle: 'owner' },
    });
  });

  it('rolls the agent claim back when its daemon exchange cannot be minted', async () => {
    await insertCode(new Date(Date.now() + 60_000));
    await expect(
      phone.claimAgentConnectPairing(
        { code: CODE, agentPubkey: AGENT, model: 'gpt-5.4' },
        async () => {
          throw new Error('exchange unavailable');
        },
      ),
    ).rejects.toThrow('exchange unavailable');
    expect((await database.query(`SELECT 1 FROM identities WHERE id=$1`, [AGENT])).rowCount).toBe(
      0,
    );
    expect(
      (
        await database.query<{ claimed_by: string | null }>(
          `SELECT claimed_by FROM agent_pairing_codes WHERE code_hash=$1`,
          [createHash('sha256').update(CODE).digest('hex')],
        )
      ).rows[0]?.claimed_by,
    ).toBeNull();
  });

  it('keeps an active agent handle unique when it pairs into another Workspace', async () => {
    await insertCode(new Date(Date.now() + 60_000));
    const first = await phone.claimAgentConnectPairing({
      code: CODE,
      agentPubkey: AGENT,
      model: 'gpt-5.4',
    });
    if (first.status !== 'claimed') throw new Error('first claim failed');

    const secondWorkspace = '33333333-3333-4333-8333-333333333333';
    const competingAgent = 'c'.repeat(64);
    const secondCode = 'BUZZ-SECOND-PAIRING';
    const handle = agentHandleFromName(first.agentName);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Second')`, [secondWorkspace]);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`, [
      competingAgent,
      first.agentName,
      handle,
    ]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      competingAgent,
      OWNER,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($3,NULL,$4,'owner')`,
      [WORKSPACE, competingAgent, secondWorkspace, OWNER],
    );
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at)
       VALUES($1,$2,$3,$4)`,
      [
        createHash('sha256').update(secondCode).digest('hex'),
        secondWorkspace,
        OWNER,
        new Date(Date.now() + 60_000),
      ],
    );

    const second = await phone.claimAgentConnectPairing({
      code: secondCode,
      agentPubkey: AGENT,
      model: 'gpt-5.4',
    });
    expect(second).toMatchObject({ status: 'claimed', agentName: first.agentName });
    expect(
      (await database.query(`SELECT handle FROM identities WHERE id=$1`, [AGENT])).rows,
    ).toEqual([{ handle: `${handle}_2` }]);
  });

  it.each([
    [new Date(Date.now() - 1_000), undefined, 'expired'],
    [new Date(Date.now() + 60_000), OWNER, 'already_claimed'],
  ] as const)('rejects expired and claimed codes clearly', async (expiresAt, claimedBy, status) => {
    await insertCode(expiresAt, claimedBy);
    await expect(
      phone.claimAgentConnectPairing({ code: CODE, agentPubkey: AGENT, model: 'gpt-5.4' }),
    ).resolves.toEqual({ status });
  });

  describe('seeded identity assignment', () => {
    async function connect(index: number): Promise<{
      pubkey: string;
      face: string;
      name: string;
      soul: string;
    }> {
      const code = `AGENT${index}`;
      await database.query(
        `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at)
         VALUES($1,$2,$3,$4)`,
        [
          createHash('sha256').update(code).digest('hex'),
          WORKSPACE,
          OWNER,
          new Date(Date.now() + 60_000),
        ],
      );
      const pubkey = index.toString(16).padStart(2, '0').repeat(32);
      const claimed = await phone.claimAgentConnectPairing({
        code,
        agentPubkey: pubkey,
        model: 'gpt-5.4',
      });
      if (claimed.status !== 'claimed') throw new Error(`claim ${index} failed`);
      return { pubkey, face: claimed.face, name: claimed.agentName, soul: claimed.soul };
    }

    it('spends every animal once before repeating, and keeps name, face and soul one animal', async () => {
      // The owner already wears one of the twelve, so eleven agents exhaust
      // the set and the twelfth is the first that must repeat.
      const ownerFace = defaultFaceForSeed(OWNER);
      const connected = [];
      for (let index = 1; index <= 11; index++) connected.push(await connect(index));
      const faces = connected.map((entry) => entry.face);
      expect(new Set(faces).size).toBe(11);
      expect(faces).not.toContain(ownerFace);
      expect(new Set(connected.map((entry) => entry.name)).size).toBe(11);
      for (const entry of connected) {
        expect(entry.soul).toBe(FACE_SOULS[entry.face as FaceId]);
        expect(FACE_NAMES[entry.face as FaceId]).toContain(entry.name);
      }

      // All twelve are worn now; the next agent falls back to the hash default
      // and still receives a face, a name, and a soul.
      const thirteenth = await connect(12);
      expect(thirteenth.face).toBe(defaultFaceForSeed(thirteenth.pubkey));
      expect(thirteenth.soul).toBe(FACE_SOULS[thirteenth.face as FaceId]);
      expect(thirteenth.name.length).toBeGreaterThan(0);
      expect(connected.map((entry) => entry.name)).not.toContain(thirteenth.name);
    });

    it('renames the connected agent from the terminal, once, through the pairing code', async () => {
      await insertCode(new Date(Date.now() + 60_000));
      const claimed = await phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        model: 'gpt-5.4',
      });
      if (claimed.status !== 'claimed') throw new Error('claim failed');

      await expect(phone.renameConnectedAgent({ code: CODE, name: '  Bramble ' })).resolves.toEqual(
        { status: 'renamed', agentName: 'Bramble' },
      );
      const renamed = await database.query<{ name: string; soul: { name: string } }>(
        `SELECT identity.name,agent.soul FROM identities identity
         JOIN agents agent ON agent.agent_id=identity.id WHERE identity.id=$1`,
        [AGENT],
      );
      // The soul's own name follows, so the roster and the harness agree.
      expect(renamed.rows[0]).toMatchObject({ name: 'Bramble', soul: { name: 'Bramble' } });

      await expect(phone.renameConnectedAgent({ code: CODE, name: 'rm -rf /' })).rejects.toThrow(
        'short spoken name',
      );
      await expect(
        phone.renameConnectedAgent({ code: 'NEVER-MINTED', name: 'Bramble' }),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('closes the rename window once the claim is no longer fresh', async () => {
      await insertCode(new Date(Date.now() + 60_000));
      await phone.claimAgentConnectPairing({ code: CODE, agentPubkey: AGENT, model: 'gpt-5.4' });
      await database.query(
        `UPDATE agent_pairing_codes SET claimed_at=now() - interval '1 hour' WHERE code_hash=$1`,
        [createHash('sha256').update(CODE).digest('hex')],
      );
      await expect(phone.renameConnectedAgent({ code: CODE, name: 'Bramble' })).resolves.toEqual({
        status: 'expired',
      });
    });
  });

  describe('finishAgentConnectPairing', () => {
    async function readJoinLine(): Promise<{ text: string; subjectName: string } | undefined> {
      const rows = await database.query<{
        text: string;
        system_event: { subject: { name: string } };
      }>(
        `SELECT message.text,message.system_event FROM messages message
         JOIN rooms room ON room.id=message.room_id
         WHERE room.workspace_id=$1 AND room.direct_participants @> jsonb_build_array($2::text,$3::text)
           AND message.card_type='workspace-member-joined'`,
        [WORKSPACE, OWNER, SYSTEM_IDENTITY_ID],
      );
      const row = rows.rows[0];
      return row ? { text: row.text, subjectName: row.system_event.subject.name } : undefined;
    }

    it('joins the Rooms the owner belongs to and announces the agent under its current name', async () => {
      await insertCode(new Date(Date.now() + 60_000));
      await phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        model: 'gpt-5.4',
        deferJoin: true,
      });

      await expect(
        phone.finishAgentConnectPairing({ code: CODE, workspaceJoined: true }),
      ).resolves.toEqual({ status: 'finished' });

      const memberships = await database.query<{ room_id: string | null }>(
        `SELECT room_id FROM memberships WHERE identity_id=$1 ORDER BY room_id NULLS FIRST`,
        [AGENT],
      );
      expect(memberships.rows).toEqual([{ room_id: null }, { room_id: ROOM }]);
    });

    // Regression: the wizard used to join Rooms (and write the "joined" line)
    // during the claim itself, before the person's rename could land — so an
    // agent renamed during `usebeeline connect` showed up in its own join line
    // under the seeded placeholder name forever. The fix moves the join and its
    // announcement to `finishAgentConnectPairing`, called only after the rename
    // decision settles, so the line always carries the name the person chose.
    it('announces the agent under a name chosen during connect, not the seeded placeholder', async () => {
      await insertCode(new Date(Date.now() + 60_000));
      const claimed = await phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        model: 'gpt-5.4',
        deferJoin: true,
      });
      if (claimed.status !== 'claimed') throw new Error('claim failed');
      const seededName = claimed.agentName;

      await expect(phone.renameConnectedAgent({ code: CODE, name: 'greeter' })).resolves.toEqual({
        status: 'renamed',
        agentName: 'greeter',
      });
      expect(
        (await database.query(`SELECT handle FROM identities WHERE id=$1`, [AGENT])).rows,
      ).toEqual([{ handle: 'greeter' }]);

      await phone.finishAgentConnectPairing({ code: CODE, workspaceJoined: true });

      const joinLine = await readJoinLine();
      expect(joinLine?.subjectName).toBe('@greeter');
      expect(joinLine?.text).toBe('@greeter joined · invited by @owner');
      expect(joinLine?.subjectName).not.toBe(seededName);
    });

    it('rejects an unknown or already-expired pairing code', async () => {
      await expect(
        phone.finishAgentConnectPairing({ code: 'NEVER-MINTED', workspaceJoined: true }),
      ).resolves.toEqual({ status: 'not_found' });

      await insertCode(new Date(Date.now() + 60_000));
      await phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        model: 'gpt-5.4',
        deferJoin: true,
      });
      await database.query(
        `UPDATE agent_pairing_codes SET claimed_at=now() - interval '1 hour' WHERE code_hash=$1`,
        [createHash('sha256').update(CODE).digest('hex')],
      );
      await expect(
        phone.finishAgentConnectPairing({ code: CODE, workspaceJoined: true }),
      ).resolves.toEqual({ status: 'expired' });
    });
  });

  describe('backward compatibility: a CLI that never sends deferJoin', () => {
    async function readJoinLine(): Promise<{ text: string; subjectName: string } | undefined> {
      const rows = await database.query<{
        text: string;
        system_event: { subject: { name: string } };
      }>(
        `SELECT message.text,message.system_event FROM messages message
         JOIN rooms room ON room.id=message.room_id
         WHERE room.workspace_id=$1 AND room.direct_participants @> jsonb_build_array($2::text,$3::text)
           AND message.card_type='workspace-member-joined'`,
        [WORKSPACE, OWNER, SYSTEM_IDENTITY_ID],
      );
      const row = rows.rows[0];
      return row ? { text: row.text, subjectName: row.system_event.subject.name } : undefined;
    }

    // Every helper installed before this fix (usebeeline 0.0.48 and older)
    // calls only `/auth/agent/connect` and never `/auth/agent/connect/finish`.
    // Against a fixed server that claim must still join Rooms and announce on
    // its own, exactly as it always has, or an old CLI would pair an agent
    // that never joins anything and never shows up.
    it('an old CLI that never calls finish still joins and announces', async () => {
      await insertCode(new Date(Date.now() + 60_000));
      const claimed = await phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        model: 'gpt-5.4',
      });
      if (claimed.status !== 'claimed') throw new Error('claim failed');

      const memberships = await database.query<{ room_id: string | null }>(
        `SELECT room_id FROM memberships WHERE identity_id=$1 ORDER BY room_id NULLS FIRST`,
        [AGENT],
      );
      expect(memberships.rows).toEqual([{ room_id: null }, { room_id: ROOM }]);
      const joinLine = await readJoinLine();
      const mention = `@${claimed.agentName.toLowerCase()}`;
      expect(joinLine).toEqual({
        text: `${mention} joined · invited by @owner`,
        subjectName: mention,
      });

      // Calling finish afterward (an old CLI never does, but a mixed rollout
      // might) is a harmless no-op: the agent is already a member everywhere
      // it would be joined, so nothing is re-announced.
      await expect(
        phone.finishAgentConnectPairing({ code: CODE, workspaceJoined: false }),
      ).resolves.toEqual({ status: 'finished' });
      const afterFinish = await database.query<{ count: string }>(
        `SELECT count(*)::text FROM messages message JOIN rooms room ON room.id=message.room_id
         WHERE room.workspace_id=$1 AND room.direct_participants @> jsonb_build_array($2::text,$3::text)
           AND message.card_type='workspace-member-joined'`,
        [WORKSPACE, OWNER, SYSTEM_IDENTITY_ID],
      );
      expect(afterFinish.rows[0]?.count).toBe('1');
    });

    // Known, accepted trade-off of keeping the old path unchanged: an old CLI
    // still renames *after* the immediate join above, so its join line stays
    // under the seeded name it started with — the original bug, for exactly
    // the population that cannot ask for the fixed, two-step behavior.
    it('still shows the seeded name after an old-style rename, since the line already wrote', async () => {
      await insertCode(new Date(Date.now() + 60_000));
      const claimed = await phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        model: 'gpt-5.4',
      });
      if (claimed.status !== 'claimed') throw new Error('claim failed');
      const seededName = claimed.agentName;

      await expect(phone.renameConnectedAgent({ code: CODE, name: 'greeter' })).resolves.toEqual({
        status: 'renamed',
        agentName: 'greeter',
      });

      const joinLine = await readJoinLine();
      expect(joinLine?.subjectName).toBe(`@${seededName.toLowerCase()}`);
      expect(joinLine?.subjectName).not.toBe('greeter');
    });
  });
});

describe('PhoneService machine grouping in readWorkbench', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  const OWNER = 'a'.repeat(64);
  const AGENT_A = 'c'.repeat(64);
  const AGENT_B = 'd'.repeat(64);
  const AGENT_C = 'e'.repeat(64);
  const WORKSPACE = '33333333-3333-4333-8333-333333333333';
  const ROOM = '44444444-4444-4444-8444-444444444444';
  const MACHINE_X = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const MACHINE_Y = 'ffffffff-gggg-4hhh-8iii-jjjjjjjjjjjj';

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')`,
      [OWNER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'MachineTest')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner')`,
      [WORKSPACE, OWNER],
    );
    phone = new PhoneService(database, 'https://server.example');
  });

  afterEach(async () => database.close());

  /** Register an agent identity and agent row in the given workspace. */
  async function registerAgent(
    agentPubkey: string,
    agentName: string,
    machineId?: string,
    machineName?: string,
  ): Promise<void> {
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`,
      [agentPubkey, agentName, agentName.toLowerCase()],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,machine_id,machine_name) VALUES($1,$2,$3,$4)`,
      [agentPubkey, OWNER, machineId ?? null, machineName ?? null],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, agentPubkey],
    );
  }

  it('two agents sharing a machine_id collapse to one machine in readWorkbench', async () => {
    await registerAgent(AGENT_A, 'Charles', MACHINE_X, 'squire-box');
    await registerAgent(AGENT_B, 'Codex', MACHINE_X);

    const result = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(result.helpers).toHaveLength(1);
    expect(result.helpers[0]!.id).toBe(MACHINE_X);
    expect(result.helpers[0]!.name).toBe('squire-box');

    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence','{"status":"online"}'::jsonb)`,
      [ROOM, AGENT_B],
    );

    const paired = await phone.execute(
      'pairConnector',
      { workspaceId: WORKSPACE, connectorType: 'trusty-squire', helperAgentId: MACHINE_X },
      OWNER,
    );
    const duringInstall = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(duringInstall.connectors.find((row) => row.connectorId === paired.connectorId)?.status.helperName)
      .toBe('squire-box');
  });

  it('two agents on different machines show two rows in readWorkbench', async () => {
    await registerAgent(AGENT_A, 'Charles', MACHINE_X, 'squire-box');
    await registerAgent(AGENT_C, 'Fathom', MACHINE_Y, 'workstation');

    const result = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(result.helpers).toHaveLength(2);
    const ids = result.helpers.map((h) => h.id).sort();
    expect(ids).toEqual([MACHINE_X, MACHINE_Y]);
  });

  it('a legacy agent without machine_id appears as its own machine', async () => {
    await registerAgent(AGENT_A, 'Charles');

    const result = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(result.helpers).toHaveLength(1);
    expect(result.helpers[0]!.id).toBe(AGENT_A); // falls back to agent_id
  });

  it('grants Squire to a future owner agent pairing onto the connected machine', async () => {
    await registerAgent(AGENT_A, 'Charles', MACHINE_X, 'squire-box');
    await phone.execute(
      'pairConnector',
      { workspaceId: WORKSPACE, connectorType: 'trusty-squire', helperAgentId: MACHINE_X },
      OWNER,
    );
    const existing = await database.query<{ agent_id: string; requested_by: string; decided_by: string }>(
      `SELECT agent_id,requested_by,decided_by FROM agent_grants
       WHERE kind='mcp' AND target='squire' AND status='approved'`,
    );
    expect(existing.rows).toEqual([
      { agent_id: AGENT_A, requested_by: OWNER, decided_by: OWNER },
    ]);

    const code = 'ABCD1234-EF567890';
    await database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at)
       VALUES($1,$2,$3,$4)`,
      [
        createHash('sha256').update(code).digest('hex'),
        WORKSPACE,
        OWNER,
        new Date(Date.now() + 60_000),
      ],
    );
    const claim = await phone.claimAgentConnectPairing({
      code,
      agentPubkey: AGENT_B,
      model: 'gpt-5.4',
      machineId: MACHINE_X,
      machineName: 'squire-box',
    });
    expect(claim.status).toBe('claimed');
    const granted = await database.query<{
      agent_id: string;
      requested_by: string;
      decided_by: string;
      status: string;
    }>(
      `SELECT agent_id,requested_by,decided_by,status FROM agent_grants
       WHERE kind='mcp' AND target='squire' AND status='approved' ORDER BY agent_id`,
    );
    expect(granted.rows).toEqual([
      { agent_id: AGENT_A, requested_by: OWNER, decided_by: OWNER, status: 'approved' },
      { agent_id: AGENT_B, requested_by: OWNER, decided_by: OWNER, status: 'approved' },
    ]);
  });

  it('pairing by machine_id creates one connector shared by both agents on that machine', async () => {
    await registerAgent(AGENT_A, 'Charles', MACHINE_X, 'squire-box');
    await registerAgent(AGENT_B, 'Codex', MACHINE_X, 'squire-box');

    // Pair using the machine_id (what the new mobile client sends)
    const paired = await phone.execute(
      'pairConnector',
      { workspaceId: WORKSPACE, connectorType: 'trusty-squire', helperAgentId: MACHINE_X },
      OWNER,
    );

    expect(paired.connectorId).toBeTruthy();
    expect(paired.status.status).toBe('installing');

    // Verify the connector is stored with the machine_id and references
    // one of the agents on that machine.
    const connector = await database.query<{
      id: string;
      helper_agent_id: string;
      machine_id: string;
    }>(
      `SELECT id,helper_agent_id,machine_id FROM workspace_connectors WHERE id=$1`,
      [paired.connectorId],
    );
    expect(connector.rows[0]!.machine_id).toBe(MACHINE_X);
    expect([AGENT_A, AGENT_B]).toContain(connector.rows[0]!.helper_agent_id);

    // Pairing again with the same machine_id returns the existing connector
    const pairedAgain = await phone.execute(
      'pairConnector',
      { workspaceId: WORKSPACE, connectorType: 'trusty-squire', helperAgentId: MACHINE_X },
      OWNER,
    );
    expect(pairedAgain.connectorId).toBe(paired.connectorId);
  });

  it('binds a machine pairing to its live agent instead of an offline sibling', async () => {
    await registerAgent(AGENT_A, 'Charles', MACHINE_X, 'squire-box');
    await registerAgent(AGENT_B, 'Codex', MACHINE_X, 'squire-box');
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence','{"status":"online"}'::jsonb)`,
      [ROOM, AGENT_B],
    );

    const workbench = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(workbench.helpers).toEqual([
      expect.objectContaining({ id: MACHINE_X, online: true }),
    ]);

    const paired = await phone.execute(
      'pairConnector',
      { workspaceId: WORKSPACE, connectorType: 'trusty-squire', helperAgentId: MACHINE_X },
      OWNER,
    );
    const connector = await database.query<{ helper_agent_id: string }>(
      `SELECT helper_agent_id FROM workspace_connectors WHERE id=$1`,
      [paired.connectorId],
    );
    expect(connector.rows[0]!.helper_agent_id).toBe(AGENT_B);
  });

  it('pairing by agent_id (back-compat) still works for legacy agents', async () => {
    await registerAgent(AGENT_A, 'Charles');

    // Legacy: no machine_id, so the agent IS its own machine.
    // Send the agent_id as helperAgentId (old client behavior).
    const paired = await phone.execute(
      'pairConnector',
      { workspaceId: WORKSPACE, connectorType: 'trusty-squire', helperAgentId: AGENT_A },
      OWNER,
    );
    expect(paired.connectorId).toBeTruthy();
    expect(paired.status.status).toBe('installing');
  });

  it('daemon machine report updates a legacy agent and collapses into one machine row', async () => {
    // Register two legacy agents without machine_id — they appear as two machines.
    await registerAgent(AGENT_A, 'Charles');
    await registerAgent(AGENT_B, 'Codex');

    let result = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(result.helpers).toHaveLength(2);
    expect(result.helpers[0]!.id).toBe(AGENT_A);
    expect(result.helpers[1]!.id).toBe(AGENT_B);

    // Simulate the daemon reporting machine_id for both agents (same machine).
    await database.query(
      `UPDATE agents SET machine_id=$2,machine_name=$3,updated_at=now() WHERE agent_id=$1`,
      [AGENT_A, MACHINE_X, 'squire-box'],
    );
    await database.query(
      `UPDATE agents SET machine_id=$2,machine_name=$3,updated_at=now() WHERE agent_id=$1`,
      [AGENT_B, MACHINE_X, 'squire-box'],
    );

    // After the report, both agents collapse into one machine row.
    result = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(result.helpers).toHaveLength(1);
    expect(result.helpers[0]!.id).toBe(MACHINE_X);
    expect(result.helpers[0]!.name).toBe('squire-box');
  });
});
