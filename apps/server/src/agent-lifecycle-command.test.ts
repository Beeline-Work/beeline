import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimAgentCommand,
  createAgentCommand,
  parseTaggedAgentLifecycleCommand,
  routeHumanMessage,
} from './agent-command.js';
import { announceAgentLifecycle } from './connection-presence.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);

describe('tagged agent lifecycle commands', () => {
  let database: PgliteDatabase;
  let live: LiveHub;

  beforeEach(async () => {
    database = new PgliteDatabase();
    live = new LiveHub();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Owner','owner'),($2,'human','Member','member'),($3,'agent','Bee','bee')`,
      [OWNER, MEMBER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),
       ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
      [WORKSPACE, ROOM, OWNER, MEMBER, AGENT],
    );
    await announceAgentLifecycle(database, live, ROOM, AGENT, { lifecycleId: 'boot-1' });
  });

  afterEach(async () => database.close());

  async function send(id: string, author: string, text: string) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      id,
      ROOM,
      author,
      text,
    ]);
    await routeHumanMessage(database, id);
  }

  it('parses only an exact tagged command', () => {
    expect(parseTaggedAgentLifecycleCommand('@bee restart', 'bee')).toBe('restart');
    expect(parseTaggedAgentLifecycleCommand(' @BEE STATUS ', 'bee')).toBe('status');
    expect(parseTaggedAgentLifecycleCommand('@bee restart please', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('restart @bee', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@other restart', 'bee')).toBeUndefined();
  });

  it('answers status and help on the server without starting a model turn', async () => {
    await send('1'.repeat(64), MEMBER, '@bee status');
    await send('2'.repeat(64), MEMBER, '@bee help');
    expect((await database.query(`SELECT 1 FROM agent_commands`)).rowCount).toBe(0);
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE presentation='system' ORDER BY created_at,id`,
        )
      ).rows.map((row) => row.text),
    ).toEqual([
      '@bee is online · no turn is running',
      '@bee supports lifecycle commands · restart · status · stop · retry · debug · help',
    ]);
  });

  it('does not add an unanswered-mention warning when an offline helper gets a server answer', async () => {
    await database.query(`DELETE FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [AGENT]);
    const phone = new PhoneService(database, 'http://local.test', undefined, undefined, live);
    await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, messageId: 'd'.repeat(64), text: '@bee status', mentions: [AGENT] },
      MEMBER,
    );
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE presentation='system' ORDER BY created_at,id`,
        )
      ).rows.map((row) => row.text),
    ).toEqual(['@bee is offline · no turn is running']);
  });

  it('enforces restart authority and deduplicates the accepted request', async () => {
    await send('3'.repeat(64), MEMBER, '@bee restart');
    expect(
      (await database.query(`SELECT 1 FROM agent_commands WHERE action='restart'`)).rowCount,
    ).toBe(0);
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE presentation='system' ORDER BY created_at DESC LIMIT 1`,
        )
      ).rows[0]?.text,
    ).toContain('only its owner or a Room manager');

    const id = '4'.repeat(64);
    await send(id, OWNER, '@bee restart');
    await routeHumanMessage(database, id);
    await send('a'.repeat(64), OWNER, '@bee restart');
    expect(
      (
        await database.query<{ lifecycle_before: string; state: string }>(
          `SELECT lifecycle_before,state FROM agent_commands WHERE action='restart'`,
        )
      ).rows,
    ).toEqual([{ lifecycle_before: 'boot-1', state: 'pending' }]);
  });

  it('confirms restart only after a claimed request reconnects with a new lifecycle', async () => {
    const id = '5'.repeat(64);
    await send(id, OWNER, '@bee restart');
    const command = (
      await database.query<{ id: string }>(`SELECT id FROM agent_commands WHERE action='restart'`)
    ).rows[0]!;
    await claimAgentCommand(database, ROOM, AGENT, command.id, 'generation-1');

    await announceAgentLifecycle(database, live, ROOM, AGENT, { lifecycleId: 'boot-1' });
    expect(
      (
        await database.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [
          command.id,
        ])
      ).rows[0]?.state,
    ).toBe('claimed');

    await announceAgentLifecycle(database, live, ROOM, AGENT, { lifecycleId: 'boot-2' });
    expect(
      (
        await database.query<{ state: string; confirmed: boolean }>(
          `SELECT state,restart_confirmed_at IS NOT NULL confirmed FROM agent_commands WHERE id=$1`,
          [command.id],
        )
      ).rows[0],
    ).toEqual({ state: 'complete', confirmed: true });
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages
           WHERE presentation='system' AND system_event->>'verb'='reconnected after restart'`,
        )
      ).rows[0]?.text,
    ).toBe('@bee reconnected after restart');
  });

  it('maps stop and retry onto authoritative turn state', async () => {
    const ask = '6'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee work')`,
      [ask, ROOM, MEMBER],
    );
    const original = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: ask,
      reason: 'human_tag',
    });
    await claimAgentCommand(database, ROOM, AGENT, original!.id, 'generation-work');
    await send('7'.repeat(64), MEMBER, '@bee stop');
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [ROOM, ask, AGENT],
        )
      ).rows[0]?.status,
    ).toBe('cancelled');
    expect(
      (await database.query(`SELECT 1 FROM agent_commands WHERE action='stop'`)).rowCount,
    ).toBe(1);

    const failedAsk = '8'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee fail')`,
      [failedAsk, ROOM, OWNER],
    );
    const failed = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: failedAsk,
      reason: 'human_tag',
    });
    await claimAgentCommand(database, ROOM, AGENT, failed!.id, 'generation-failed');
    await database.query(
      `UPDATE agent_turns SET status='failed',failure_reason='provider failed' WHERE request_id=$1`,
      [failedAsk],
    );
    await database.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [failed!.id]);
    await send('9'.repeat(64), OWNER, '@bee retry');
    expect(
      (
        await database.query<{ action: string; reason: string; turn_request_id: string }>(
          `SELECT action,reason,turn_request_id FROM agent_commands WHERE source_message_id=$1`,
          ['9'.repeat(64)],
        )
      ).rows[0],
    ).toEqual({ action: 'resume', reason: 'tagged_lifecycle_retry', turn_request_id: failedAsk });
  });
});
