import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FACE_NAMES,
  FACE_SOULS,
  defaultFaceForSeed,
  isFaceId,
  type FaceId,
} from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

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
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
      OWNER,
    ]);
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
      face_id: string;
      owner_id: string;
      selected_model: string;
      soul: { name: string; instructions: string };
    }>(
      `SELECT identity.name,identity.face_id,agent.owner_id,agent.selected_model,agent.soul
       FROM identities identity JOIN agents agent ON agent.agent_id=identity.id
       WHERE identity.id=$1`,
      [AGENT],
    );
    expect(identity.rows).toEqual([
      {
        name: claim.agentName,
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
      const rows = await database.query<{ text: string; system_event: { subject: { name: string } } }>(
        `SELECT text,system_event FROM messages WHERE room_id=$1 AND card_type='member-joined'`,
        [ROOM],
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

      await expect(
        phone.renameConnectedAgent({ code: CODE, name: 'greeter' }),
      ).resolves.toEqual({ status: 'renamed', agentName: 'greeter' });

      await phone.finishAgentConnectPairing({ code: CODE, workspaceJoined: true });

      const joinLine = await readJoinLine();
      expect(joinLine?.subjectName).toBe('greeter');
      expect(joinLine?.text).toBe('greeter joined');
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
      const rows = await database.query<{ text: string; system_event: { subject: { name: string } } }>(
        `SELECT text,system_event FROM messages WHERE room_id=$1 AND card_type='member-joined'`,
        [ROOM],
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
      expect(joinLine).toEqual({ text: `${claimed.agentName} joined`, subjectName: claimed.agentName });

      // Calling finish afterward (an old CLI never does, but a mixed rollout
      // might) is a harmless no-op: the agent is already a member everywhere
      // it would be joined, so nothing is re-announced.
      await expect(
        phone.finishAgentConnectPairing({ code: CODE, workspaceJoined: false }),
      ).resolves.toEqual({ status: 'finished' });
      const afterFinish = await database.query<{ count: string }>(
        `SELECT count(*)::text FROM messages WHERE room_id=$1 AND card_type='member-joined'`,
        [ROOM],
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
      expect(joinLine?.subjectName).toBe(seededName);
      expect(joinLine?.subjectName).not.toBe('greeter');
    });
  });
});
