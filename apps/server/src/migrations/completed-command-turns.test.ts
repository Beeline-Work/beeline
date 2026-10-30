import { expect, it } from 'vitest';
import { migrate, migrateData } from '../database.js';
import { PgliteDatabase } from '../test-support.js';
import { createAgentCommand, claimAgentCommand } from '../agent-command.js';

it('stuck-turn-1: release migration closes orphan turns once and preserves a live claimed successor', async () => {
  const database = new PgliteDatabase();
  const human = 'a'.repeat(64),
    agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111',
    room = '22222222-2222-4222-8222-222222222222';
  try {
    await migrate(database, { deferData: true });
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Ruby')`,
      [human, agent],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`, [
      room,
      workspace,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [workspace, human, agent, room],
    );
    const orphanIds: string[] = [];
    for (let index = 0; index < 6; index++) {
      const request = String(index).repeat(64);
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@ruby work')`,
        [request, room, human],
      );
      const command = await createAgentCommand(database, {
        roomId: room,
        agentId: agent,
        sourceMessageId: request,
        reason: 'human_tag',
      });
      await claimAgentCommand(database, room, agent, command!.id, `old-${index}`);
      await database.query(
        `UPDATE agent_commands SET state='complete',completed_at=now()-interval '2 days' WHERE id=$1`,
        [command!.id],
      );
      await database.query(
        `UPDATE agent_turns SET created_at=now()-interval '2 days',generation_id='retired-generation' WHERE request_id=$1`,
        [request],
      );
      if (index < 5) orphanIds.push(request);
      else {
        const source = 'f'.repeat(64);
        await database.query(
          `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'resume')`,
          [source, room, human],
        );
        const successor = await createAgentCommand(database, {
          roomId: room,
          agentId: agent,
          sourceMessageId: source,
          reason: 'resume',
          action: 'resume',
          turnRequestId: request,
        });
        await claimAgentCommand(database, room, agent, successor!.id, 'live-successor');
      }
    }
    await migrateData(database);
    expect(
      (
        await database.query(
          `SELECT status,failure_reason FROM agent_turns WHERE request_id=ANY($1::text[])`,
          [orphanIds],
        )
      ).rows,
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        status: 'failed',
        failure_reason: 'the command completed without a terminal turn receipt',
      })),
    );
    expect(
      (
        await database.query(`SELECT status,generation_id FROM agent_turns WHERE request_id=$1`, [
          '5'.repeat(64),
        ])
      ).rows,
    ).toEqual([{ status: 'working', generation_id: 'live-successor' }]);
    // The release marker prevents a later release from running this repair again.
    await database.query(
      `UPDATE agent_commands SET state='complete' WHERE generation_id='live-successor'`,
    );
    await migrateData(database);
    expect(
      (await database.query(`SELECT status FROM agent_turns WHERE request_id=$1`, ['5'.repeat(64)]))
        .rows,
    ).toEqual([{ status: 'working' }]);
  } finally {
    await database.close();
  }
});
