import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER_ROOM = '33333333-3333-4333-8333-333333333333';
const REQUESTER = '1'.repeat(64), ROLE_OWNER = '2'.repeat(64), ROOM_ADMIN = '3'.repeat(64);
const WORKSPACE_ADMIN = '4'.repeat(64), OUTSIDER = '5'.repeat(64);
const SAVER = 'a'.repeat(64), WORKER = 'b'.repeat(64), DELEGATE = 'c'.repeat(64);
let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, origin: string;
const tokens = new Map<string, string>();

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  for (const [id, kind, name] of [
    [REQUESTER, 'human', 'Requester'], [ROLE_OWNER, 'human', 'Role owner'],
    [ROOM_ADMIN, 'human', 'Room admin'], [WORKSPACE_ADMIN, 'human', 'Workspace admin'],
    [OUTSIDER, 'human', 'Unrelated member'], [SAVER, 'agent', 'Saver'],
    [WORKER, 'agent', 'Worker'], [DELEGATE, 'agent', 'Delegate'],
  ]) await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,$2,$3)`, [id, kind, name]);
  await db.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$4,'opus-4-5'),($2,$4,'opus-4-5'),($3,$5,'opus-4-5')`,
    [SAVER, WORKER, DELEGATE, ROLE_OWNER, OUTSIDER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Permissions proof')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Team'),($2,$3,'Other team')`, [ROOM, OTHER_ROOM, WORKSPACE]);
  for (const who of [REQUESTER, ROLE_OWNER, ROOM_ADMIN, WORKSPACE_ADMIN, OUTSIDER, SAVER, WORKER, DELEGATE]) {
    for (const room of [ROOM, OTHER_ROOM]) await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
      [WORKSPACE, room, who, who === ROOM_ADMIN ? 'admin' : 'member']);
  }
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'admin')`, [WORKSPACE, WORKSPACE_ADMIN]);
  for (const agent of [SAVER, WORKER, DELEGATE]) await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [ROOM, agent]);
  const auth = new TokenAuth(db, async () => ({ subject: 'proof', login: 'proof' }));
  const live = new LiveHub();
  server = createBeelineServer({ database: db, auth, live, phone: new PhoneService(db, 'http://placeholder'), daemon: new DaemonService(db, live) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const agent of [SAVER, WORKER, DELEGATE]) tokens.set(agent,
    (await auth.exchangeDaemonToken((await auth.createDaemonExchange(agent)).exchangeToken))!.daemonToken);
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

async function call(agent: string, operation: string, payload: object) {
  const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.get(agent)}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function turn(actor: string, agent = SAVER, roomId = ROOM) {
  const source = randomUUID();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Manage this workflow')`, [source, roomId, actor]);
  const command = await createAgentCommand(db, { roomId, agentId: agent, sourceMessageId: source, reason: 'human_message' });
  const generationId = randomUUID();
  expect((await call(agent, 'claimAgentCommand', { roomId, commandId: command!.id, generationId })).status).toBe(200);
  const context = { roomId, requestId: command!.turn_request_id, generationId };
  expect((await call(agent, 'postAgentTurnReceipt', { ...context, agentId: agent, status: 'working' })).status).toBe(200);
  return context;
}

async function savedWorkflow(actor = REQUESTER) {
  const context = await turn(actor);
  const name = `proof-${randomUUID()}`;
  const contract = { version: 1, name, description: 'Workflow permissions proof', summary: 'Check workflow control authority',
    roles: ['worker'], start: 'work', handoffs: {
      work: { role: 'worker', does: 'Perform the work', timeoutSeconds: 3600, requires: [], on: { done: 'done', timeout: 'failed' } },
      done: { kind: 'terminal', status: 'done', does: 'Finish the run' },
      failed: { kind: 'terminal', status: 'failed', does: 'End an expired run' },
    } };
  const saved = await call(SAVER, 'saveWorkflow', { ...context, contract });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return { context, name };
}

async function runSnapshot(runId: string) {
  return (await db.query(`SELECT id,card FROM messages WHERE card->>'runId'=$1 ORDER BY (card->>'seq')::int`, [runId])).rows;
}

describe('workflow control through authenticated daemon HTTP operations', () => {
  it('Reproduction run-permissions: denies unrelated reassignment and archive without changing state', async () => {
    const { context, name } = await savedWorkflow();
    const started = await call(SAVER, 'startWorkflow', { ...context, name, roleBindings: { worker: WORKER } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const runId = started.body.runId as string;
    const before = await runSnapshot(runId);
    // Even the agent holding this role cannot act for an unrelated person.
    const denied = await call(WORKER, 'assignWorkflowRole', {
      ...await turn(OUTSIDER, WORKER), runId, role: 'worker', targetAgentId: DELEGATE,
    });
    const after = await runSnapshot(runId);
    const archived = await call(DELEGATE, 'archiveWorkflow', { ...await turn(OUTSIDER, DELEGATE, OTHER_ROOM), name });
    const skill = (await db.query(`SELECT state FROM workspace_skills WHERE slug=$1`, [name])).rows[0];
    console.log('Reproduction run-permissions:', JSON.stringify({ assignmentStatus: denied.status,
      runUnchanged: JSON.stringify(before) === JSON.stringify(after), archiveStatus: archived.status, workflowState: skill?.state }));
    expect(denied.status).toBe(403);
    expect(after).toEqual(before);
    expect(archived.status).toBe(403);
    expect(skill?.state).toBe('active');
    const nextStart = await call(DELEGATE, 'startWorkflow', { ...await turn(REQUESTER, DELEGATE, OTHER_ROOM), name,
      roleBindings: { worker: DELEGATE } });
    expect(nextStart.status, JSON.stringify(nextStart.body)).toBe(200);
  });

  it.each([['requester', REQUESTER], ['role owner', ROLE_OWNER], ['Room admin', ROOM_ADMIN], ['Workspace admin', WORKSPACE_ADMIN]])(
    'allows %s to reassign through a different agent', async (_label, actor) => {
      const { context, name } = await savedWorkflow();
      const started = await call(SAVER, 'startWorkflow', { ...context, name, roleBindings: { worker: WORKER } });
      expect(started.status).toBe(200);
      const assigned = await call(DELEGATE, 'assignWorkflowRole', { ...await turn(actor, DELEGATE),
        runId: started.body.runId, role: 'worker', targetAgentId: SAVER });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
      const latest = (await runSnapshot(started.body.runId as string)).at(-1)?.card as { roleBindings: object };
      expect(latest.roleBindings).toEqual({ worker: SAVER });
    });

  it.each([['saved requester', REQUESTER], ['saving agent', SAVER], ['saving agent owner', ROLE_OWNER], ['Room admin', ROOM_ADMIN], ['Workspace admin', WORKSPACE_ADMIN]])(
    'allows %s to archive through a different agent', async (_label, actor) => {
      const { name } = await savedWorkflow(actor === ROLE_OWNER || actor === SAVER ? SAVER : REQUESTER);
      const archived = await call(DELEGATE, 'archiveWorkflow', { ...await turn(actor, DELEGATE), name });
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
      expect(archived.body).toEqual({ slug: name, archived: true });
      expect((await db.query(`SELECT state FROM workspace_skills WHERE slug=$1`, [name])).rows[0]?.state).toBe('stale');
      const unavailable = await call(DELEGATE, 'startWorkflow', { ...await turn(actor, DELEGATE, OTHER_ROOM), name,
        roleBindings: { worker: DELEGATE } });
      expect(unavailable.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(unavailable.body)).toContain('workflow is unavailable');
    });

  it('allows the owner of an unselected list member to reassign, just as cancel does', async () => {
    const { context, name } = await savedWorkflow();
    const started = await call(SAVER, 'startWorkflow', { ...context, name, roleBindings: { worker: [WORKER, DELEGATE] } });
    expect(started.status).toBe(200);
    const assigned = await call(DELEGATE, 'assignWorkflowRole', { ...await turn(OUTSIDER, DELEGATE),
      runId: started.body.runId, role: 'worker', targetAgentId: SAVER });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const latest = (await runSnapshot(started.body.runId as string)).at(-1)?.card as { roleBindings: object };
    expect(latest.roleBindings).toEqual({ worker: SAVER });
  });

  it('does not invent archive ownership when saved provenance is deleted; admins can still archive', async () => {
    const { context, name } = await savedWorkflow();
    await db.query(`UPDATE messages SET deleted_at=now() WHERE id=(SELECT root_source_message_id FROM agent_commands WHERE turn_request_id=$1)`, [context.requestId]);
    const denied = await call(DELEGATE, 'archiveWorkflow', { ...await turn(REQUESTER, DELEGATE), name });
    expect(denied.status).toBe(403);
    expect((await db.query(`SELECT state FROM workspace_skills WHERE slug=$1`, [name])).rows[0]?.state).toBe('active');
    const archived = await call(DELEGATE, 'archiveWorkflow', { ...await turn(WORKSPACE_ADMIN, DELEGATE), name });
    expect(archived.status).toBe(200);
    expect(archived.body).toEqual({ slug: name, archived: true });
  });
});
