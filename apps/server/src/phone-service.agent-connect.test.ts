import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('atomically creates and binds the generated agent before returning the grant metadata', async () => {
    await insertCode(new Date(Date.now() + 60_000));

    await expect(
      phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        agentName: 'Scout',
        model: 'gpt-5.4',
        soul: 'Brisk and kind.',
      }),
    ).resolves.toEqual({
      status: 'claimed',
      workspaceId: WORKSPACE,
      workspaceName: 'Builders',
      pairedBy: OWNER,
    });
    const identity = await database.query<{
      name: string;
      owner_id: string;
      selected_model: string;
    }>(
      `SELECT identity.name,agent.owner_id,agent.selected_model
       FROM identities identity JOIN agents agent ON agent.agent_id=identity.id
       WHERE identity.id=$1`,
      [AGENT],
    );
    expect(identity.rows).toEqual([{ name: 'Scout', owner_id: OWNER, selected_model: 'gpt-5.4' }]);
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
        {
          code: CODE,
          agentPubkey: AGENT,
          agentName: 'Scout',
          model: 'gpt-5.4',
          soul: 'Brisk and kind.',
        },
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
      phone.claimAgentConnectPairing({
        code: CODE,
        agentPubkey: AGENT,
        agentName: 'Scout',
        model: 'gpt-5.4',
        soul: 'Brisk and kind.',
      }),
    ).resolves.toEqual({ status });
  });
});
