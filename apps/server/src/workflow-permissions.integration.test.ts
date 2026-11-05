import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER_ROOM = '33333333-3333-4333-8333-333333333333';
const REQUESTER = '1'.repeat(64), ROLE_OWNER = '2'.repeat(64), ROOM_ADMIN = '3'.repeat(64);
const WORKSPACE_ADMIN = '4'.repeat(64), OUTSIDER = '5'.repeat(64);
const SAVER = 'a'.repeat(64), WORKER = 'b'.repeat(64), DELEGATE = 'c'.repeat(64);
let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, origin: string;
const tokens = new Map<string, string>();

beforeAll(async () => {
  db = await migratedDatabase();
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
  const saved = await call(SAVER, 'saveWorkflow', { ...context, contract: proofContract(name) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return { context, name };
}

function proofContract(name: string, description = 'Workflow permissions proof') {
  return { version: 1, name, description, summary: 'Check workflow control authority',
    roles: ['worker'], start: 'work', handoffs: {
      work: { role: 'worker', does: 'Perform the work', timeoutSeconds: 3600, requires: [], on: { done: 'done', timeout: 'failed' } },
      done: { kind: 'terminal', status: 'done', does: 'Finish the run' },
      failed: { kind: 'terminal', status: 'failed', does: 'End an expired run' },
    } };
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

  it.each([['requester', REQUESTER], ['role owner', ROLE_OWNER], ['Workspace admin', WORKSPACE_ADMIN]])(
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

  // Archiving deletes a saved workflow for the Workspace: who saved it grants nothing.
  it.each([['saved requester', REQUESTER], ['saving agent', SAVER], ['saving agent owner', ROLE_OWNER]])(
    'refuses %s, who is not a Workspace admin, to archive', async (_label, actor) => {
      const { name } = await savedWorkflow(actor === ROLE_OWNER || actor === SAVER ? SAVER : REQUESTER);
      const archived = await call(DELEGATE, 'archiveWorkflow', { ...await turn(actor, DELEGATE), name });
      expect(archived.status).toBe(403);
      expect(JSON.stringify(archived.body)).toContain('workspace admins only');
      expect((await db.query(`SELECT state FROM workspace_skills WHERE slug=$1`, [name])).rows[0]?.state).toBe('active');
    });

  it.each([['Workspace admin', WORKSPACE_ADMIN]])(
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

  it('refuses a Room admin who is only a Workspace member to reassign or archive', async () => {
    const { context, name } = await savedWorkflow();
    const started = await call(SAVER, 'startWorkflow', { ...context, name, roleBindings: { worker: WORKER } });
    expect(started.status).toBe(200);
    const assigned = await call(DELEGATE, 'assignWorkflowRole', { ...await turn(ROOM_ADMIN, DELEGATE),
      runId: started.body.runId, role: 'worker', targetAgentId: SAVER });
    expect(assigned.status).toBe(403);
    const archived = await call(DELEGATE, 'archiveWorkflow', { ...await turn(ROOM_ADMIN, DELEGATE), name });
    expect(archived.status).toBe(403);
    expect((await db.query(`SELECT state FROM workspace_skills WHERE slug=$1`, [name])).rows[0]?.state).toBe('active');
  });

  it('lets only a Workspace admin change a saved workflow through the authenticated save path', async () => {
    const { name } = await savedWorkflow();
    const version = async () => (await db.query<{ current_version: number }>(
      `SELECT current_version FROM workspace_skills WHERE slug=$1`, [name])).rows[0]?.current_version;
    const snapshot = async () => (await db.query(
      `SELECT skill.current_version,skill.revision,skill.source_room_id,skill.state,
         (SELECT jsonb_agg(jsonb_build_object('version',v.version,'sources',v.source_message_ids) ORDER BY v.version)
          FROM workspace_skill_versions v WHERE v.skill_id=skill.id) versions
       FROM workspace_skills skill WHERE skill.slug=$1`, [name])).rows[0];
    const before = await snapshot();
    for (const actor of [REQUESTER, ROLE_OWNER, ROOM_ADMIN]) {
      const refused = await call(SAVER, 'saveWorkflow', { ...await turn(actor), contract: proofContract(name, `Edited by ${actor.slice(0, 4)}`) });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).toContain('workspace admins only');
      expect(await version()).toBe(1);
    }
    // Saving it unchanged, even from another Room, is a no-op: version,
    // revision, source Room and provenance all stay as they were.
    const unchanged = await call(DELEGATE, 'saveWorkflow', { ...await turn(OUTSIDER, DELEGATE, OTHER_ROOM), contract: proofContract(name) });
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    expect(unchanged.body).toEqual({ slug: name, version: 1 });
    expect(await snapshot()).toEqual(before);
    const edited = await call(SAVER, 'saveWorkflow', { ...await turn(WORKSPACE_ADMIN), contract: proofContract(name, 'Edited by an admin') });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ slug: name });
    expect(await version()).toBeGreaterThan(1);
  });

  it('lets concurrent saves of a new name create it once and refuses the non-admin change', async () => {
    const name = `proof-${randomUUID()}`;
    const [first, second] = await Promise.all([
      call(SAVER, 'saveWorkflow', { ...await turn(REQUESTER), contract: proofContract(name, 'First') }),
      call(SAVER, 'saveWorkflow', { ...await turn(OUTSIDER), contract: proofContract(name, 'Second') }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, JSON.stringify([first.body, second.body])).toEqual([200, 403]);
    const row = (await db.query<{ current_version: number }>(`SELECT current_version FROM workspace_skills WHERE slug=$1`, [name])).rows[0];
    expect(row?.current_version).toBe(1);
  });

  it('lets only a Workspace admin edit or delete an agent-made schedule through authenticated daemon HTTP', async () => {
    const created = await call(SAVER, 'createAgentSchedule', { ...await turn(REQUESTER), title: 'Daily check',
      prompt: 'Check the Room.', cadence: { kind: 'interval', everyMinutes: 60 } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const scheduleId = created.body.scheduleId as string;
    const row = async () => (await db.query(`SELECT message,cadence FROM agent_schedules WHERE id=$1`, [scheduleId])).rows[0];
    const before = await row();
    // The requester, a Room admin who is a Workspace member, and the scheduling
    // agent's own (non-admin) owner are all refused, and nothing changes.
    for (const actor of [REQUESTER, ROOM_ADMIN, ROLE_OWNER]) {
      const edit = await call(SAVER, 'updateAgentSchedule', { ...await turn(actor), scheduleId, prompt: 'Rewritten.' });
      expect(edit.status).toBe(403);
      expect(JSON.stringify(edit.body)).toContain('workspace admins only');
      const remove = await call(SAVER, 'deleteAgentSchedule', { ...await turn(actor), scheduleId });
      expect(remove.status).toBe(403);
      expect(await row()).toEqual(before);
    }
    const edited = await call(SAVER, 'updateAgentSchedule', { ...await turn(WORKSPACE_ADMIN), scheduleId, prompt: 'Check it twice.' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await row())?.message).toBe('Check it twice.');
    const removed = await call(SAVER, 'deleteAgentSchedule', { ...await turn(WORKSPACE_ADMIN), scheduleId });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await row()).toBeUndefined();
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

describe('Reproduction run-id-prefix: authenticated run lookup and control', () => {
  async function started() {
    const { context, name } = await savedWorkflow();
    const result = await call(SAVER, 'startWorkflow', { ...context, name, roleBindings: { worker: WORKER } });
    expect(result.status).toBe(200);
    return result.body.runId as string;
  }

  it.each(['getWorkflowRun', 'handoff', 'cancelWorkflowRun', 'assignWorkflowRole'])(
    'resolves a unique eight-character prefix for %s and returns the canonical ID', async (operation) => {
      const runId = await started();
      const context = operation === 'handoff' ? await turn(REQUESTER, WORKER) : await turn(REQUESTER);
      const agent = operation === 'handoff' ? WORKER : SAVER;
      const result = await call(agent, operation, { ...context, runId: runId.slice(0, 8),
        ...(operation === 'handoff' ? { outcome: 'done', contents: {}, attempt: 0 } : {}),
        ...(operation === 'cancelWorkflowRun' ? { reason: 'Prefix proof' } : {}),
        ...(operation === 'assignWorkflowRole' ? { role: 'worker', targetAgentId: DELEGATE } : {}),
      });
      console.log('Reproduction run-id-prefix:', operation, JSON.stringify({ status: result.status, runId: result.body.runId, state: result.body.state, error: result.body.error }));
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.runId).toBe(runId);
      const read = await call(SAVER, 'getWorkflowRun', { roomId: ROOM, runId });
      expect(read.status).toBe(200);
      expect(read.body.runId).toBe(runId);
      if (operation === 'handoff') expect(read.body.status).toBe('done');
      if (operation === 'cancelWorkflowRun') expect(read.body.status).toBe('abandoned');
      if (operation === 'assignWorkflowRole') expect(read.body.boundAgentId).toBe(DELEGATE);
    });

  it('rejects short and ambiguous prefixes and excludes other Rooms and workspaces', async () => {
    const runId = await started();
    const prefix = runId.slice(0, 8);
    const second = prefix + (runId[8] === 'a' ? 'b' : 'a') + runId.slice(9);
    const hidden = prefix + 'f'.repeat(56);
    const foreignWorkspace = randomUUID(), foreignRoom = randomUUID();
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hidden')`, [foreignWorkspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Hidden')`, [foreignRoom, foreignWorkspace]);
    for (const [id, room] of [[second, ROOM], [hidden, foreignRoom]]) await db.query(
      `INSERT INTO messages(id,room_id,author_id,card_type,card,text)
       SELECT $1,$2,author_id,card_type,jsonb_set(card,'{runId}',to_jsonb($1::text)),text FROM messages WHERE id=$3`,
      [id, room, runId]);
    const context = await turn(REQUESTER);
    for (const operation of ['getWorkflowRun', 'handoff', 'cancelWorkflowRun', 'assignWorkflowRole']) {
      const before = await runSnapshot(runId);
      const extra = { outcome: 'done', contents: {}, reason: 'Stop', role: 'worker', targetAgentId: DELEGATE };
      const ambiguous = await call(SAVER, operation, { ...context, ...extra, runId: prefix });
      expect(ambiguous.status).toBeGreaterThanOrEqual(400);
      const error = JSON.stringify(ambiguous.body);
      expect(error).toContain('ambiguous');
      expect(error).toContain(runId);
      expect(error).toContain(second);
      expect(error).not.toContain(hidden);
      const short = await call(SAVER, operation, { ...context, ...extra, runId: prefix.slice(0, 7) });
      expect(short.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(short.body)).toContain('at least 8 characters');
      const unavailable = await call(SAVER, operation, { ...context, ...extra, runId: hidden.slice(0, 12) });
      expect(JSON.stringify(unavailable.body)).toContain('unavailable in this Room');
      expect(JSON.stringify(unavailable.body)).not.toContain(hidden);
      expect(await runSnapshot(runId)).toEqual(before);
    }
    const exactDespiteAmbiguity = await call(SAVER, 'getWorkflowRun', { roomId: ROOM, runId });
    expect(exactDespiteAmbiguity.status).toBe(200);
    expect(exactDespiteAmbiguity.body.runId).toBe(runId);
    await db.query(`DELETE FROM messages WHERE id=$1`, [second]);
    const uniqueDespiteHidden = await call(SAVER, 'getWorkflowRun', { roomId: ROOM, runId: prefix });
    expect(uniqueDespiteHidden.status).toBe(200);
    expect(uniqueDespiteHidden.body.runId).toBe(runId);
    // Cancelling is open to anyone in the Room, so the unrelated member's
    // prefix resolves and the run ends.
    const memberCancel = await call(DELEGATE, 'cancelWorkflowRun', { ...await turn(OUTSIDER, DELEGATE), runId: prefix, reason: 'Anyone in the Room' });
    expect(memberCancel.status, JSON.stringify(memberCancel.body)).toBe(200);
    expect(memberCancel.body.status).toBe('abandoned');
    const longer = await call(SAVER, 'getWorkflowRun', { roomId: ROOM, runId: runId.slice(0, 9) });
    expect(longer.status).toBe(200);
    expect(longer.body.runId).toBe(runId);
    const otherRoom = await call(SAVER, 'getWorkflowRun', { roomId: OTHER_ROOM, runId: prefix });
    expect(JSON.stringify(otherRoom.body)).toContain('unavailable in this Room');
    const deniedRoom = await call(SAVER, 'getWorkflowRun', { roomId: foreignRoom, runId: prefix });
    expect(deniedRoom.status).toBe(403);
    expect(JSON.stringify(deniedRoom.body)).not.toContain(hidden);
  });
});
