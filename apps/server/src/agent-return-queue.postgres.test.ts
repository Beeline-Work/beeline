import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { createAgentCommand, readAgentCommands, routeHumanMessage, routeSystemCommand } from './agent-command.js';
import { claimAgentConnection } from './connection-presence.js';
import { commanderReportAddress, reportToCommander } from './commander.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.skipIf(!url)('returning helper consumes the current place once (real PostgreSQL)', () => {
  const human = 'a'.repeat(64), agent = 'b'.repeat(64), commander = 'c'.repeat(64), workspace = randomUUID();
  let fixture: Awaited<ReturnType<typeof groupBPostgresDatabase>>;
  beforeAll(async () => {
    fixture = await groupBPostgresDatabase(url!);
    await fixture.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'agent','Worker','worker'),($3,'agent','Commander','commander')`, [human,agent,commander]);
    await fixture.database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [agent,commander,human]);
    await fixture.database.query("INSERT INTO workspaces(id,name) VALUES($1,'Return queue')", [workspace]);
    await fixture.database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES
      ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')`, [workspace,human,agent,commander]);
  }, 60_000);
  afterAll(async () => { await fixture?.close(); });
  async function place(parent?: string) {
    const room = randomUUID();
    await fixture.database.query("INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Place',$4)",
      [room,workspace,parent ?? null,parent ? agent : human]);
    if (!parent) await fixture.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`, [workspace,room,human,agent,commander]);
    return room;
  }
  it('offline mentions, lifecycle and schedules produce one invocation per place, preserving private orders and new arrivals', async () => {
    const db = fixture.database, rooms = [await place(), await place()];
    const queued: Record<string, AgentCommand[]> = {};
    for (const roomId of rooms) {
      for (const text of ['Old mention one', 'Old mention two']) {
        const id = randomUUID();
        await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)", [id,roomId,human,`@worker ${text}`]);
        await routeHumanMessage(db,id);
      }
      for (const [text, kind] of [['Old lifecycle notice', 'corner-opened'], ['Missed schedule run', 'schedule-ran'], ['Current place wake', 'schedule-ran']]) {
        const id = randomUUID();
        await db.query(`INSERT INTO messages(id,room_id,author_id,text,system_event) VALUES($1,$2,$3,$4,$5::jsonb)`,
          [id,roomId,human,text,JSON.stringify({kind,scheduleId:randomUUID()})]);
        if (text === 'Current place wake') await db.query('UPDATE messages SET attachments=$2::jsonb WHERE id=$1',
          [id,JSON.stringify([{url:'https://files.example.test/current.txt',name:'current.txt',mimeType:'text/plain',size:1}])]);
        await routeSystemCommand(db,{roomId,sourceMessageId:id,kind,targets:[agent]});
      }
      for (const text of ['Private order one', 'Private order two']) await createAgentCommand(db, {
        roomId,agentId:agent,sourceMessageId:null,reason:'order',
        privatePayload:{kind:'order',authorId:commander,fromRoomId:roomId,text},
      });
      queued[roomId] = (await readAgentCommands(db,roomId,agent)).commands;
      expect(queued[roomId]).toHaveLength(7);
    }
    expect((await db.query('SELECT agent_id FROM agent_connections WHERE agent_id=$1',[agent])).rowCount).toBe(0);
    const live = new LiveHub(), daemon = new DaemonService(db,live);
    await db.query("INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('return-queue',clock_timestamp())");
    const owner = {connectionId:'return-queue',epoch:await claimAgentConnection(db,live,agent,{},
      {connectionId:'return-queue',instanceId:'return-queue'})};
    for (const roomId of rooms) {
      const scratch = await mkdtemp(join(tmpdir(),'beeline-return-queue-'));
      const abort = new AbortController(), context = new CommandExecutionContext(scratch);
      const invocations: string[] = [], errors: unknown[] = [];
      let released = false;
      const api = {
        turnOwnershipScope:() => owner,
        execute:async (name:string,input:Record<string,unknown>) => {
          const result = await daemon.execute(name as never,input as never,agent,
            ['claimAgentTurn','releaseAgentTurn'].includes(name) ? owner : undefined);
          if (name === 'releaseAgentTurn') released = true;
          return result;
        },
      } as unknown as DaemonApiClient;
      const running = runServerCommandIntake({api,roomId,agentId:agent,context,signal:abort.signal,
        stop:() => {},onError:error => errors.push(error),run:async command => {
          invocations.push(command.source.body);
          // A later event belongs to the next turn; never consume beyond this claim.
          if (roomId === rooms[0] && invocations.length === 1) await createAgentCommand(db,{roomId,agentId:agent,sourceMessageId:null,reason:'order',
            privatePayload:{kind:'order',authorId:commander,fromRoomId:roomId,text:'Arrived during turn'}});
          else abort.abort();
        }});
      try {
        await vi.waitFor(() => { expect(errors).toEqual([]); expect(released).toBe(true); });
        await vi.waitFor(() => expect(invocations).toHaveLength(roomId === rooms[0] ? 2 : 1));
        await running;
        const first = invocations[0]!;
        expect(first).toContain('current state');
        expect(first).toContain('Current place wake');
        expect(first).toContain('https://files.example.test/current.txt');
        expect(first).not.toContain('Old mention');
        expect(first).not.toContain('Old lifecycle');
        expect(first).not.toContain('Missed schedule run');
        for (const text of ['Private order one','Private order two']) expect(first.split(text)).toHaveLength(2);
        if (roomId === rooms[0]) {
          expect(invocations[1]).toContain('Arrived during turn');
          expect(invocations[1]).not.toContain('Private order one');
        }
        expect(errors).toEqual([]);
        expect((await readAgentCommands(db,roomId,agent)).commands).toEqual([]);
        expect((await db.query("SELECT id FROM agent_commands WHERE room_id=$1 AND state<>'complete'",[roomId])).rows).toEqual([]);
        expect((await db.query("SELECT request_id FROM agent_turns WHERE room_id=$1 AND status='working'",[roomId])).rows).toEqual([]);
      } finally { abort.abort(); await running; await rm(scratch,{recursive:true,force:true}); }
    }
  }, 30_000);
  it('a self-opened corner whose parent command expired reports to its recorded human opening request', async () => {
    const db = fixture.database, parentRoom = await place(), corner = await place(parentRoom), root = randomUUID();
    await db.query("INSERT INTO corner_facts(corner_id) VALUES($1)",[corner]);
    await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Do operations in a corner and report here')",[root,parentRoom,human]);
    const opening = (await createAgentCommand(db,{roomId:corner,agentId:agent,sourceMessageId:root,reason:'corner_objective'}))!;
    await db.query("UPDATE agent_commands SET parent_command_id='expired-parent' WHERE id=$1",[opening.id]);
    const source = randomUUID();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,system_event) VALUES($1,$2,$3,'Scheduled work','{"kind":"schedule-ran"}')`,[source,corner,human]);
    const wake = (await createAgentCommand(db,{roomId:corner,agentId:agent,sourceMessageId:source,reason:'schedule'}))!;
    expect(await commanderReportAddress(db,corner,wake)).toMatchObject({recipient:human,returnRoom:parentRoom});
    expect(await commanderReportAddress(db,corner,{...wake,agent_id:commander}))
      .toMatchObject({recipient:agent,returnRoom:parentRoom});
    await reportToCommander(db,corner,agent,'blocked: Current work needs its commander',wake);
    expect((await db.query("SELECT author_id,room_id FROM messages WHERE text='blocked: Current work needs its commander'")).rows)
      .toEqual([{author_id:agent,room_id:parentRoom}]);
    expect((await db.query("SELECT id FROM agent_commands WHERE reason='report' AND agent_id=$1",[agent])).rows).toEqual([]);
  });
});
