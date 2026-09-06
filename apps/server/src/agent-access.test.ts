import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService, ACCESS_POLICY_AUTHORITY_MESSAGE } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const OWNER = 'a'.repeat(64);
const OUTSIDER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Charles'),($2,'human','Bananaman'),($3,'agent','Greeter')`,
    [OWNER, OUTSIDER, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'welcome')`,
    [ROOM, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
    [WORKSPACE, OWNER, OUTSIDER, AGENT, ROOM],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  return database;
}

type Line = { text: string; presentation: string; author_id: string; mention_ids: string[] };
async function lines(database: PgliteDatabase): Promise<Line[]> {
  return (
    await database.query<Line>(
      `SELECT text,presentation,author_id,mention_ids FROM messages
       WHERE room_id=$1 AND presentation='system' ORDER BY created_at,id`,
      [ROOM],
    )
  ).rows;
}

async function setPolicy(database: PgliteDatabase, type: string): Promise<void> {
  await database.query(`UPDATE agents SET access_policy=$2::jsonb WHERE agent_id=$1`, [
    AGENT,
    JSON.stringify({ type }),
  ]);
}

/** A helper heartbeat, as `postAgentPresence` writes it. */
async function reportPresence(
  database: PgliteDatabase,
  status: 'online' | 'offline',
  ageSeconds = 0,
): Promise<void> {
  await database.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence',$3::jsonb,now() - make_interval(secs => $4))
     ON CONFLICT(room_id,agent_id,turn_id,kind)
     DO UPDATE SET body=EXCLUDED.body,updated_at=EXCLUDED.updated_at`,
    [
      ROOM,
      AGENT,
      JSON.stringify({ status, observedAt: Math.floor(Date.now() / 1000) - ageSeconds }),
      ageSeconds,
    ],
  );
}

const send = (phone: PhoneService, sender: string, seed: string, text: string) =>
  phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: seed.repeat(64).slice(0, 64), text, mentions: [AGENT] },
    sender,
  );

describe('who may address an agent', () => {
  it('defaults a newly connected agent to everyone', async () => {
    const database = await fixture();
    try {
      // The column default is what a fresh `agents` row lands on: the pairing
      // insert names it explicitly, and this is the floor under it.
      expect(
        (
          await database.query<{ access_policy: { type: string } }>(
            `SELECT access_policy FROM agents WHERE agent_id=$1`,
            [AGENT],
          )
        ).rows[0]?.access_policy,
      ).toEqual({ type: 'everyone' });
    } finally {
      await database.close();
    }
  });

  it('answers everyone under the default, and inscribes one refusal under creator', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await reportPresence(database, 'online');

      // Default policy: nothing to explain, so nothing is written.
      await send(phone, OUTSIDER, '1', '@greeter yo');
      expect(await lines(database)).toEqual([]);

      await setPolicy(database, 'creator');
      await send(phone, OUTSIDER, '2', '@greeter yo again');
      expect(await lines(database)).toEqual([
        {
          author_id: AGENT,
          presentation: 'system',
          // No mention: the line wakes no daemon and pushes to nobody.
          mention_ids: [],
          text:
            'Greeter did not answer Bananaman · only Charles may address Greeter, ' +
            'ask them for permission in the members page',
        },
      ]);

      // One explanation per window, not one per message: a second ask inside the
      // window collides on the line's derived id and writes nothing.
      await send(phone, OUTSIDER, '3', '@greeter please');
      await send(phone, OUTSIDER, '4', '@greeter hello?');
      expect(await lines(database)).toHaveLength(1);

      // The owner is permitted, so their mention is never explained away.
      await send(phone, OWNER, '5', '@greeter status');
      expect(await lines(database)).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it('says a mention went unread when the helper is not there', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      // Permitted sender, no helper: silence would be indistinguishable from a
      // refusal, so the Room carries the other fact instead.
      await send(phone, OUTSIDER, '1', '@greeter yo');
      expect(await lines(database)).toEqual([
        expect.objectContaining({
          author_id: AGENT,
          text: 'Greeter did not answer Bananaman · its helper is offline, so nothing was started',
        }),
      ]);

      // A stale heartbeat is not a live helper either.
      await reportPresence(database, 'online', 600);
      await send(phone, OWNER, '2', '@greeter status');
      expect(await lines(database)).toHaveLength(2);

      // A fresh heartbeat says nothing at all.
      await reportPresence(database, 'online');
      await send(phone, OWNER, '3', '@greeter again');
      expect(await lines(database)).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it('hands a running helper the server policy, changed or not, on every candidate message', async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      const authority = () =>
        daemon.execute('getRoomAuthority', { roomId: ROOM, principalId: OUTSIDER }, AGENT);

      expect(await authority()).toMatchObject({ member: true, mayAddressAgent: true });

      await setPolicy(database, 'creator');
      // No reconnect, no restart, nothing cached: the next poll asks and is told.
      expect(await authority()).toMatchObject({ member: true, mayAddressAgent: false });
      expect(
        await daemon.execute('getRoomAuthority', { roomId: ROOM, principalId: OWNER }, AGENT),
      ).toMatchObject({ mayAddressAgent: true });

      await setPolicy(database, 'everyone');
      expect(await authority()).toMatchObject({ mayAddressAgent: true });
    } finally {
      await database.close();
    }
  });

  it('lets the owner change the policy and says so in the Room, and refuses anyone else', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await expect(
        phone.execute(
          'updateAgentAccessPolicy',
          { workspaceId: WORKSPACE, agentId: AGENT, policy: 'creator' },
          OUTSIDER,
        ),
      ).rejects.toThrow(ACCESS_POLICY_AUTHORITY_MESSAGE);

      await phone.execute(
        'updateAgentAccessPolicy',
        { workspaceId: WORKSPACE, agentId: AGENT, policy: 'creator' },
        OWNER,
      );
      expect(await lines(database)).toEqual([
        expect.objectContaining({
          author_id: OWNER,
          text: 'Charles changed who may address Greeter · only Charles may ask now',
        }),
      ]);

      // The profile reads the row, so the app and the running helper agree.
      expect((await phone.readAgent(WORKSPACE, AGENT, OWNER))?.access).toEqual({
        policy: 'creator',
        owner: { id: OWNER, name: 'Charles' },
        canChange: true,
      });

      await phone.execute(
        'updateAgentAccessPolicy',
        { workspaceId: WORKSPACE, agentId: AGENT, policy: 'everyone' },
        OWNER,
      );
      expect((await lines(database)).at(-1)?.text).toBe(
        'Charles changed who may address Greeter · anyone in the Room may ask now',
      );
      // A member who cannot change it still sees the truth.
      expect((await phone.readAgent(WORKSPACE, AGENT, OUTSIDER))?.access).toMatchObject({
        policy: 'everyone',
        canChange: false,
      });
    } finally {
      await database.close();
    }
  });
});
