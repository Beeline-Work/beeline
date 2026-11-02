import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { createAgentCommand } from './agent-command.js';
import { clearConnectedAppPlaceholders } from './migrations/connected-app-turns.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { RoomsMcpAgentTools } from './rooms-mcp-agent.js';
import { LiveHub } from './live.js';

const H = 'a'.repeat(64), APP = 'b'.repeat(64), MACHINE = 'c'.repeat(64), SENDER = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','App','app'),
    ($3,'agent','Machine','machine'),($4,'agent','Sender','sender')`, [H, APP, MACHINE, SENDER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [APP, MACHINE, SENDER, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'R1')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Origin')`, [R, C, W]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  for (const who of [H, APP, MACHINE, SENDER]) for (const room of [null, R])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W, room, who]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('r1-app','R1 app','[]')`);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label)
    VALUES('r1-app',$1,$2,'ChatGPT')`, [H, APP]);
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM agent_turns');
});
const report = (text: string, agentId = APP, authorId = SENDER, origin = C, id?: string) => createAgentCommand(db, {
  id, roomId: R, agentId, sourceMessageId: null, reason: 'report',
  privatePayload: { kind: 'report', text, authorId, fromRoomId: origin, originCornerId: origin },
});
const working = async (agentId: string) => (await phone.readRoom(R, H))!.latestAgentTurns
  .filter(t => t.agentPubkey === agentId && t.status === 'working');

it('R1: app dispatch is quiet, machine dispatch works, and a real MCP tool turn is visible', async () => {
  await report('needs-decision: approve the numbered list');
  const machine = await report('needs-decision: another decision', MACHINE);
  expect(await working(APP)).toEqual([]);
  expect(await working(MACHINE)).toEqual([expect.objectContaining({ generationId: `pending:${machine!.id}` })]);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = daemon.execute.bind(daemon);
  vi.spyOn(daemon, 'execute').mockImplementation(async (...args) => {
    if (args[0] === 'searchInstitutionalHistory') {
      entered();
      await gate;
      return { items: [] } as never;
    }
    return execute(...args);
  });
  const call = new RoomsMcpAgentTools(db, daemon).call(APP, 'search', { address: R, scope: 'history', query: 'numbered list' });
  await started;
  try {
    expect(await working(APP)).toEqual([expect.objectContaining({ generationId: expect.stringMatching(/^mcp:/) })]);
  } finally { release(); await call; }
  expect(await working(APP)).toEqual([]);
});

it('R1: three reports about one unhandled decision retain only the newest text', async () => {
  const first = await report('needs-decision: approve the list');
  const second = await report('needs-decision: all checks passed; approve the list');
  const third = await report('needs-decision: latest context for the same approval');
  expect((await db.query(`SELECT id,state,cancellation_reason FROM agent_commands ORDER BY inbox_sequence`)).rows).toEqual([
    { id: first!.id, state: 'cancelled', cancellation_reason: 'superseded_report' },
    { id: second!.id, state: 'cancelled', cancellation_reason: 'superseded_report' },
    { id: third!.id, state: 'pending', cancellation_reason: null },
  ]);
  expect((await db.query(`SELECT private_payload->>'text' text FROM agent_commands WHERE state='pending'`)).rows)
    .toEqual([{ text: 'needs-decision: latest context for the same approval' }]);
  // Replaying an already accepted id cannot cancel its replacement.
  await report('needs-decision: approve the list', APP, SENDER, C, first!.id);
  expect((await db.query(`SELECT id FROM agent_commands WHERE state='pending'`)).rows).toEqual([{ id: third!.id }]);
});

it('R1: status, sender, origin and recipient distinguish new reports; claimed work survives', async () => {
  const claimed = await report('needs-decision: active decision');
  await daemon.execute('claimAgentCommand', { roomId: R, commandId: claimed!.id, generationId: 'picked-up' }, APP);
  expect(await working(APP)).toEqual([expect.objectContaining({ generationId: 'picked-up' })]);
  await report('needs-decision: newer context');
  await report('blocked: different status');
  await report('needs-decision: different sender', APP, MACHINE);
  await report('needs-decision: different origin', APP, SENDER, R);
  await report('needs-decision: different recipient', MACHINE);
  expect((await db.query(`SELECT state,count(*)::int n FROM agent_commands GROUP BY state ORDER BY state`)).rows)
    .toEqual([{ state: 'claimed', n: 1 }, { state: 'pending', n: 5 }]);
});

it('R1: release cleanup removes legacy app placeholders and preserves real and machine turns', async () => {
  for (const [agent, request, generation] of [
    [APP, 'legacy', 'pending:legacy'], [APP, 'real', 'mcp:real'],
    [MACHINE, 'machine', 'pending:machine'],
  ]) await db.query(`INSERT INTO agent_turns(room_id,agent_id,request_id,status,generation_id)
    VALUES($1,$2,$3,'working',$4)`, [R, agent, request, generation]);
  await clearConnectedAppPlaceholders(db);
  await clearConnectedAppPlaceholders(db);
  expect((await db.query(`SELECT generation_id FROM agent_turns ORDER BY generation_id`)).rows)
    .toEqual([{ generation_id: 'mcp:real' }, { generation_id: 'pending:machine' }]);
  expect(await working(APP)).toEqual([expect.objectContaining({ generationId: 'mcp:real' })]);
  expect(await working(MACHINE)).toEqual([expect.objectContaining({ generationId: 'pending:machine' })]);
});

it('R1: expired claims can be superseded, while handled reports and machine queues retain their history', async () => {
  const expired = await report('needs-decision: old context');
  await daemon.execute('claimAgentCommand', { roomId: R, commandId: expired!.id, generationId: 'expired' }, APP);
  await db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [expired!.id]);
  const current = await report('needs-decision: new context');
  expect((await db.query(`SELECT status FROM agent_turns WHERE request_id=$1`, [expired!.turn_request_id])).rows)
    .toEqual([{ status: 'cancelled' }]);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [current!.id]);
  await report('needs-decision: a later decision after handling');
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [current!.id])).rows).toEqual([{ state: 'complete' }]);
  await report('needs-decision: machine decision', MACHINE);
  await report('needs-decision: another machine update', MACHINE);
  expect((await db.query(`SELECT count(*)::int n FROM agent_commands WHERE agent_id=$1 AND state='pending'`, [MACHINE])).rows)
    .toEqual([{ n: 2 }]);
});
