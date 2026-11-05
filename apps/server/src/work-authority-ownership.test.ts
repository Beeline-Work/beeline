import { RoomsMcpAgentTools } from './rooms-mcp-agent.js';
import type { DaemonService } from './daemon-service.js';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from "../../../tests/helpers/server.js";
import {
  claimAgentCommand,
  claimMcpOrder,
  createAgentCommand,
  createClaimedMcpAgentCommand,
  dismissAgentCommandWakes,
  releaseUnreportedMcpOrder,
  settleAgentCommand,
  type CommandRow,
} from './agent-command.js';
import { PhoneService } from './phone-service.js';

const human = 'a'.repeat(64),
  agent = 'b'.repeat(64),
  workspace = randomUUID(),
  room = randomUUID();
const root = 'c'.repeat(64);
let db: PgliteDatabase;
beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')`,
    [human, agent],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$3,$4,'member')`,
    [workspace, human, room, agent],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please check the work')`,
    [root, room, human],
  );
});
afterEach(() => db.close());
async function order() {
  return (await createAgentCommand(db, {
    roomId: room,
    agentId: agent,
    sourceMessageId: root,
    action: 'input',
    reason: 'order',
    privatePayload: { kind: 'order', authorId: human, fromRoomId: room, text: 'Check this work' },
  }))!;
}
for (const ingress of ['helper', 'MCP implicit', 'MCP commandId'] as const) {
  describe(ingress, () => {
    const claim = (command: CommandRow, generation = `mcp:${randomUUID()}`) =>
      db.transaction(async (tx) => {
        const result =
          ingress === 'helper'
            ? await claimAgentCommand(tx, room, agent, command.id, generation)
            : await claimMcpOrder(
                tx,
                agent,
                room,
                generation,
                ingress === 'MCP commandId' ? command.id : undefined,
              );
        if (!result) throw new Error('order unavailable');
        return result;
      });
    it('refuses a cancelled turn atomically without claiming its pending command', async () => {
      const command = await order();
      await db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'cancelled')
        ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='cancelled'`,
        [room, command.turn_request_id, agent],
      );
      await expect(claim(command)).rejects.toThrow();
      expect(
        (await db.query(`SELECT state,generation_id FROM agent_commands WHERE id=$1`, [command.id]))
          .rows[0],
      ).toMatchObject({ state: 'pending', generation_id: null });
    });
    it('honors delayed wakes until the due owner releases them', async () => {
      const command = await order();
      await db.query(`UPDATE agent_commands SET wake_after=now()+interval '1 hour' WHERE id=$1`, [
        command.id,
      ]);
      await expect(claim(command)).rejects.toThrow();
      expect(
        (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!
          .state,
      ).toBe('pending');
      await db.query(`UPDATE agent_commands SET wake_after=NULL WHERE id=$1`, [command.id]);
      expect((await claim(command)).state).toBe('claimed');
    });
    it('cannot revive a human Stop through claim, release or completion', async () => {
      const command = await order(),
        claimed = await claim(command);
      const queued = await order();
      await new PhoneService(db, 'http://test').execute(
        'cancelAgentTurn',
        { roomId: room, agentId: agent, requestId: command.turn_request_id },
        human,
      );
      await expect(claim(command)).rejects.toThrow();
      await expect(claim(queued)).rejects.toThrow();
      expect(
        (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [queued.id])).rows[0]!
          .state,
      ).toBe('cancelled');
      await db.transaction((tx) =>
        releaseUnreportedMcpOrder(tx, command.id, claimed.generation_id!),
      );
      await settleAgentCommand(db, claimed, 'complete');
      expect(
        (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!
          .state,
      ).toBe('cancelled');
      expect(
        (
          await db.query(
            `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
            [room, command.turn_request_id, agent],
          )
        ).rows[0]!.status,
      ).toBe('cancelled');
    });
  });
}
it('retains explicit MCP generation reuse and refuses takeover of a current helper owner', async () => {
  const command = await order();
  const first = await db.transaction((tx) =>
    claimMcpOrder(tx, agent, room, 'mcp:first', command.id),
  );
  const second = await db.transaction((tx) =>
    claimMcpOrder(tx, agent, room, 'mcp:second', command.id),
  );
  expect(second!.generation_id).toBe(first!.generation_id);
  await db.transaction((tx) => releaseUnreportedMcpOrder(tx, command.id, first!.generation_id!));
  await db.transaction((tx) => claimAgentCommand(tx, room, agent, command.id, 'helper'));
  expect(
    await db.transaction((tx) => claimMcpOrder(tx, agent, room, 'mcp:third', command.id)),
  ).toBeUndefined();
});

it('rolls back an explicit app command if its canonical working-turn claim is refused', async () => {
  await db.query(`CREATE FUNCTION refuse_app_turn() RETURNS trigger AS $$ BEGIN
    IF NEW.reason='mcp_call' THEN
      INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES(NEW.room_id,NEW.turn_request_id,NEW.agent_id,'cancelled');
    END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER refuse_app_turn AFTER INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION refuse_app_turn();`);
  await expect(
    createClaimedMcpAgentCommand(db, {
      roomId: room,
      agentId: agent,
      generationId: 'mcp:refused',
      requesterMessageId: root,
    }),
  ).rejects.toThrow('cancelled');
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE reason='mcp_call'`)).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM agent_turns`)).rowCount).toBe(0);
});
it('does not complete directly when the normal connected-app receipt is refused', async () => {
  const daemon = {
    execute: async (name: string) => {
      if (name === 'postAgentTurnReceipt') throw new Error('receipt refused');
      return { items: [] };
    },
  } as unknown as DaemonService;
  const mcp = new RoomsMcpAgentTools(db, daemon);
  await expect(
    mcp.call(agent, 'search', { address: room, scope: 'history', query: 'needle' }),
  ).rejects.toThrow('receipt refused');
  expect((await db.query(`SELECT state FROM agent_commands WHERE reason='mcp_call'`)).rows).toEqual(
    [{ state: 'claimed' }],
  );
  expect((await db.query(`SELECT status FROM agent_turns`)).rows).toEqual([{ status: 'working' }]);
});

it('dismisses an expired non-order through the command and turn settlement owner', async () => {
  const command = (await createAgentCommand(db, {
    roomId: room,
    agentId: agent,
    sourceMessageId: root,
    action: 'input',
    reason: 'system',
  }))!;
  const claimed = await db.transaction((tx) =>
    claimAgentCommand(tx, room, agent, command.id, 'mcp:expired'),
  );
  await db.query(
    `UPDATE agent_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1`,
    [command.id],
  );
  expect(await dismissAgentCommandWakes(db, room, agent, command.id)).toBe(1);
  expect(
    (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!.state,
  ).toBe('complete');
  expect(
    (
      await db.query(
        `SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND generation_id=$4`,
        [room, agent, claimed.turn_request_id, claimed.generation_id],
      )
    ).rows[0]!.status,
  ).toBe('complete');
});
