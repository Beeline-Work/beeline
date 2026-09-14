import { describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { resolveCurrentMemberMentions, taggedIdentityIdsSql } from './message-mentions.js';
import { PushDeliveryLoop } from './background.js';

const AUTHOR = 'a'.repeat(64);
const BEE = 'b'.repeat(64);
const CARL = 'c'.repeat(64);
const AGENT = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

/**
 * A top-level Room (AUTHOR, BEE, CARL, AGENT) plus one corner under it whose
 * OWN membership deliberately omits BEE — `@channel` in the corner must still
 * reach BEE through the parent Room, not the corner's narrower roster.
 */
async function fixture(): Promise<PgliteDatabase> {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Author','author'),($2,'human','Bee','bee'),
      ($3,'human','Carl','carl'),($4,'agent','Greeter','greeter')`,
    [AUTHOR, BEE, CARL, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Fix the thing')`,
    [CORNER, WORKSPACE, ROOM],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, AUTHOR]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'member'),
      ($1,$7,$3,'owner'),($1,$7,$6,'member')`,
    [WORKSPACE, ROOM, AUTHOR, BEE, CARL, AGENT, CORNER],
  );
  return database;
}

describe('@channel mention expansion', () => {
  it('resolves to every current human Room member except the author, never an agent', async () => {
    const database = await fixture();
    try {
      const resolved = await resolveCurrentMemberMentions(
        database,
        ROOM,
        '@channel ship it',
        AUTHOR,
      );
      expect(resolved.map((member) => member.id).sort()).toEqual([BEE, CARL].sort());
      expect(resolved.every((member) => member.kind === 'human')).toBe(true);
    } finally {
      await database.close();
    }
  });

  it('is case-insensitive and ignores @channel written inside a quoted line', async () => {
    const database = await fixture();
    try {
      expect(
        (await resolveCurrentMemberMentions(database, ROOM, '@CHANNEL ship it', AUTHOR)).map(
          (member) => member.id,
        ),
      ).toEqual(expect.arrayContaining([BEE, CARL]));
      expect(
        await resolveCurrentMemberMentions(database, ROOM, '> @channel already said this', AUTHOR),
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it('reads live via taggedIdentityIdsSql, agreeing with resolveCurrentMemberMentions', async () => {
    const database = await fixture();
    try {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@channel ping')`,
        ['1'.repeat(64), ROOM, AUTHOR],
      );
      const tagged = (
        await database.query<{ tagged_ids: string[] }>(
          `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m WHERE m.id=$1`,
          ['1'.repeat(64)],
        )
      ).rows[0]!.tagged_ids;
      expect(tagged.sort()).toEqual([BEE, CARL].sort());
    } finally {
      await database.close();
    }
  });

  it('in a corner, tags the humans of the corner\'s PARENT Room, not the corner\'s own narrower roster', async () => {
    const database = await fixture();
    try {
      // The corner's own membership omits BEE (see fixture), yet @channel in
      // the corner still reaches BEE because the token resolves against the
      // parent Room's current human roster.
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@channel status update')`,
        ['2'.repeat(64), CORNER, AGENT],
      );
      const tagged = (
        await database.query<{ tagged_ids: string[] }>(
          `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m WHERE m.id=$1`,
          ['2'.repeat(64)],
        )
      ).rows[0]!.tagged_ids;
      expect(tagged.sort()).toEqual([AUTHOR, BEE, CARL].sort());

      const resolved = await resolveCurrentMemberMentions(
        database,
        CORNER,
        '@channel status update',
        AGENT,
      );
      expect(resolved.map((member) => member.id).sort()).toEqual([AUTHOR, BEE, CARL].sort());
    } finally {
      await database.close();
    }
  });

  it('never includes an agent, even one who could otherwise be @handle-tagged', async () => {
    const database = await fixture();
    try {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@channel and @greeter too')`,
        ['3'.repeat(64), ROOM, AUTHOR],
      );
      const tagged = (
        await database.query<{ tagged_ids: string[] }>(
          `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m WHERE m.id=$1`,
          ['3'.repeat(64)],
        )
      ).rows[0]!.tagged_ids;
      // @greeter is a real, distinct @handle tag; @channel's expansion never
      // adds the agent on top of it.
      expect(tagged.sort()).toEqual([AGENT, BEE, CARL].sort());
    } finally {
      await database.close();
    }
  });
});

describe('@channel push delivery', () => {
  it('reaches every human member device exactly once, and never the author or an agent', async () => {
    const database = await fixture();
    try {
      for (const [token, identity] of [
        ['author-device-1234567890123456789', AUTHOR],
        ['bee-device-12345678901234567890', BEE],
        ['carl-device-1234567890123456789', CARL],
      ] as const) {
        await database.query(
          `INSERT INTO push_devices(token,identity_id,platform,environment)
           VALUES($1,$2,'android','physical')`,
          [token, identity],
        );
      }
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(database, { send });
      // Prime the delivery floor so the fixture-only backlog is not itself
      // eligible, matching how a fresh install behaves before real traffic.
      await loop.runOnce();
      send.mockClear();

      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@channel heads up')`,
        ['4'.repeat(64), ROOM, AUTHOR],
      );
      expect(await loop.runOnce()).toBe(2);
      expect(send).toHaveBeenCalledTimes(2);
      const pushedTokens = send.mock.calls.map(([token]) => token).sort();
      expect(pushedTokens).toEqual(
        ['bee-device-12345678901234567890', 'carl-device-1234567890123456789'].sort(),
      );
      expect(await loop.runOnce()).toBe(0);
    } finally {
      await database.close();
    }
  });
});
