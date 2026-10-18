import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimAgentCommand, routeHumanMessage } from './agent-command.js';
import { migrate } from './database.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const OTHER_HUMAN = 'c'.repeat(64);
const OTHER_AGENT = 'd'.repeat(64);
const MESSAGE = 'e'.repeat(64);

describe('solo-agent-untagged-silence', () => {
  let db: PgliteDatabase;
  let phone: PhoneService;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Human','human'),($2,'agent','Agent','agent'),
      ($3,'human','Other human','other'),($4,'agent','Other agent','other-agent')`,
      [HUMAN, AGENT, OTHER_HUMAN, OTHER_AGENT]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`,
      [AGENT, OTHER_AGENT, HUMAN]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Solo')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,
      [WORKSPACE, ROOM, HUMAN, AGENT]);
    phone = new PhoneService(db, 'http://local.test', undefined, undefined, new LiveHub());
  });
  afterEach(async () => db.close());

  async function send(text = 'Hello lol') {
    await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: MESSAGE, text }, HUMAN);
    return (await db.query<{ agent_id: string; source_message_id: string; id: string }>(
      `SELECT agent_id,source_message_id,id FROM agent_commands WHERE source_message_id=$1`, [MESSAGE])).rows;
  }

  it('dispatches and claims the untagged phone message once', async () => {
    const commands = await send();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ agent_id: AGENT, source_message_id: MESSAGE });
    await routeHumanMessage(db, MESSAGE);
    expect((await db.query(`SELECT 1 FROM agent_commands WHERE source_message_id=$1`, [MESSAGE])).rowCount).toBe(1);
    await claimAgentCommand(db, ROOM, AGENT, commands[0]!.id, 'solo-proof');
    expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [commands[0]!.id])).rows[0]?.state).toBe('claimed');
    await new DaemonService(db, new LiveHub()).execute('postRoomMessage', {
      roomId: ROOM, requestId: MESSAGE, generationId: 'solo-proof', text: 'Hello back!',
    }, AGENT);
    const view = await phone.readRoom(ROOM, HUMAN);
    expect(JSON.stringify(view)).toContain('Hello back!');
  });

  it.each([OTHER_HUMAN, OTHER_AGENT])('does not wake with an extra member %s', async extra => {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [WORKSPACE, ROOM, extra]);
    expect(await send()).toEqual([]);
  });

  it.each(['@channel hi', '@other hi', '@unknown hi', '@system hi'])('does not infer a target for %s', async text => {
    expect(await send(text)).toEqual([]);
  });

  it('ignores removed memberships when counting', async () => {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role,removed_at)
      VALUES($1,$2,$3,'member',now()),($1,$2,$4,'member',now())`, [WORKSPACE, ROOM, OTHER_HUMAN, OTHER_AGENT]);
    expect(await send()).toHaveLength(1);
  });

  it('keeps direct conversations routing through their participants', async () => {
    await db.query(`UPDATE rooms SET direct_participants=$2 WHERE id=$1`, [ROOM, [HUMAN, AGENT]]);
    expect(await send()).toHaveLength(1);
    expect((await db.query(`SELECT reason FROM agent_commands`)).rows[0]?.reason).toBe('direct_message');
  });

  it('does not infer a target in a corner', async () => {
    const parent = '33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [parent, WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [WORKSPACE, parent, HUMAN, AGENT]);
    await db.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [ROOM, parent]);
    expect(await send()).toEqual([]);
  });

  it.each(['agent', 'system'])('does not route %s messages', async kind => {
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
      VALUES($1,$2,$3,'Hello lol',$4)`, [MESSAGE, ROOM, kind === 'agent' ? AGENT : HUMAN, kind === 'system' ? 'system' : 'message']);
    await routeHumanMessage(db, MESSAGE);
    expect((await db.query(`SELECT 1 FROM agent_commands`)).rowCount).toBe(0);
  });
});
