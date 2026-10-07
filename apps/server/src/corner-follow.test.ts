import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { backfillCornerFollows } from './corner-follow.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const PERSON = 'a'.repeat(64);
const TEAMMATE = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const ORIGIN = 'https://server.usebeeline.app';

let database: PgliteDatabase;
let phone: PhoneService;
let sequence = 0;

async function post(text: string, author: string, channel = CORNER) {
  const id = (++sequence).toString(16).padStart(64, '0');
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
     VALUES($1,$2,$3,$4,now()+$5::interval)`,
    [id, channel, author, text, `${sequence} seconds`],
  );
  return id;
}

/** Whether the person's chat list dropdown and Corners page count the corner as theirs. */
async function mine() {
  const chats = await phone.readChats(WORKSPACE, PERSON);
  const listed = chats?.chats
    .find((chat) => chat.room.id === ROOM)
    ?.openCorners?.find((corner) => corner.id === CORNER);
  const page = (await phone.readCorners(ROOM, PERSON))?.corners.find(
    (item) => item.corner.id === CORNER,
  );
  return { list: listed?.mine === true, page: page?.followsViewer === true };
}

beforeEach(async () => {
  sequence = 0;
  database = new PgliteDatabase();
  await migrate(database);
  phone = new PhoneService(database, ORIGIN);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES ($1,'human','Person','person'),($2,'human','Teammate','teammate'),($3,'agent','Bee','bee')`,
    [PERSON, TEAMMATE, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  // The teammate opened and commissioned the corner; the person did neither.
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$3,'Room',NULL,$4),($2,$3,'Corner',$1,$4)`,
    [ROOM, CORNER, WORKSPACE, TEAMMATE],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective) VALUES($1,$2,$3,'Work')`,
    [CORNER, AGENT, TEAMMATE],
  );
  for (const channel of [null, ROOM, CORNER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'owner'),($1,$2,$5,'member')`,
      [WORKSPACE, channel, PERSON, TEAMMATE, AGENT],
    );
});
afterEach(() => database.close());

describe('Mine corners use the push Followed rule', () => {
  it('leaves out a corner the person never touched', async () => {
    await post('Untagged update', TEAMMATE);
    expect(await mine()).toEqual({ list: false, page: false });
  });

  it('includes a corner the person posted in', async () => {
    await post('I have a thought', PERSON);
    await post('Untagged update', TEAMMATE);
    expect(await mine()).toEqual({ list: true, page: true });
  });

  it('includes a corner the person was tagged in, after the corner moves on', async () => {
    await post('@person can you look', TEAMMATE);
    await post('Untagged update', AGENT);
    expect(await mine()).toEqual({ list: true, page: true });
  });

  it('includes a corner the person steered from its Room', async () => {
    const ask = await post('@bee tell the corner to use Postgres', PERSON, ROOM);
    const relay = await post('Use Postgres', AGENT);
    await database.query(
      `INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
       VALUES('steer',$1,$2,$3,'turn','input','relay_steer','root',$4,1)`,
      [CORNER, AGENT, relay, ask],
    );
    expect(await mine()).toEqual({ list: true, page: true });
  });

  it('includes a corner the person commissioned', async () => {
    await database.query(`UPDATE corner_facts SET commissioned_by=$1 WHERE corner_id=$2`, [
      PERSON,
      CORNER,
    ]);
    expect(await mine()).toEqual({ list: true, page: true });
  });

  it('backfills follows for corners that predate the table', async () => {
    await post('I have a thought', PERSON);
    await database.query(`DELETE FROM corner_follows`);
    expect(await mine()).toEqual({ list: false, page: false });
    await backfillCornerFollows(database);
    expect(await mine()).toEqual({ list: true, page: true });
  });

  it('backfills a tag from the transcript once', async () => {
    await post('@person can you look', TEAMMATE);
    await database.query(`DELETE FROM corner_follows`);
    await backfillCornerFollows(database);
    expect(await mine()).toEqual({ list: true, page: true });
  });
});
