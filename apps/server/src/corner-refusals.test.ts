import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { migrate } from './database.js';
import { PgliteDatabase, describedWorkflow } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { CommandRefusalError } from './commander.js';
import { CornerVerdictRejectedError } from './corner-merge-approval.js';
import { createAgentCommand } from './agent-command.js';
import { captureException } from '@sentry/node';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
const db = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const head = 'c'.repeat(40);
const live = new LiveHub();
const daemon = new DaemonService(db, live);
vi.spyOn(daemon, 'warmConnectorIndex').mockResolvedValue();
let server: ReturnType<typeof createBeelineServer>;
let origin: string;

beforeAll(async () => {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Reviewer')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Refusal proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [parent, workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`, [corner, workspace, parent]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, parent, agent]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [corner, agent]);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_refusal_fixture_123456789'), agent]);
  server = createBeelineServer({ database: db, daemon, live, auth: new TokenAuth(db, async () => { throw new Error('unused'); }), phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db.close();
});

async function refusal(operation: 'archiveCorner' | 'approveCornerMerge', message: string) {
  vi.mocked(captureException).mockClear();
  const input = { cornerId: corner, ...(operation === 'approveCornerMerge' ? { headSha: 'd'.repeat(40) } : {}) };
  const error = await daemon.execute(operation, input as never, agent).catch(error => error);
  expect(error.message).toBe(message);
  expect(error).toBeInstanceOf(CommandRefusalError);
  expect(error.status).toBe(409);
  const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
    method: 'POST', headers: { authorization: 'Bearer bdt_refusal_fixture_123456789', 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  expect(await response.json()).toEqual({ error: message });
  expect(response.status).toBe(409);
  expect(captureException).not.toHaveBeenCalled();
  expect((await db.query('SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1', [corner])).rowCount).toBe(0);
  expect((await db.query('SELECT archived_at FROM rooms WHERE id=$1', [corner])).rows[0].archived_at).toBeNull();
  return error;
}

it('Reproduction SENTRY-B: close_corner with a PR returns unchanged refusal without Sentry capture', async () => {
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [corner, JSON.stringify({ pr: { number: 7, headSha: head } })]);
  await refusal('archiveCorner', 'close the corner pull request with close_corner_pr before closing the corner');
});

it.each([
  ['NOT_CONFIGURED_REVIEWER', "only this corner's configured reviewer or its zero-check commander can record PASS"],
  ['NO_PULL_REQUEST', 'corner has no pull request'],
  ['STALE_HEAD', `pull request head is ${head}; review the current head before approving`],
] as const)('Reproduction SENTRY-C: %s returns unchanged code and excludes Sentry', async (code, detail) => {
  await db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [parent, code === 'NOT_CONFIGURED_REVIEWER' ? null : agent]);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [corner, JSON.stringify(code === 'NO_PULL_REQUEST' ? {} : { pr: { number: 7, headSha: head } })]);
  const error = await refusal('approveCornerMerge', `${code}: ${detail}`);
  expect(error).toBeInstanceOf(CornerVerdictRejectedError);
  expect(error.code).toBe(code);
  expect(error.name).toBe('CornerVerdictRejectedError');
});

it('Reproduction OPEN-1 / SENTRY-D: agent-message opening succeeds without Sentry capture', async () => {
  const source = '1'.repeat(64), invalidApproval = '2'.repeat(64);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$3,$4,'Open work'),($2,$3,$5,'Agent suggestion')`, [source, invalidApproval, parent, owner, agent]);
  const command = await createAgentCommand(db, { roomId: parent, agentId: agent, sourceMessageId: source, reason: 'human_tag' });
  await daemon.execute('claimAgentCommand', { roomId: parent, commandId: command!.id, generationId: 'proof' }, agent);
  const input = { roomId: parent, requestId: command!.turn_request_id, generationId: 'proof',
    name: 'Agent-initiated', objective: 'Open agent-initiated work',
    brief: { spec: 'Do the assigned work', approval: { sourceMessageId: invalidApproval } } };
  vi.mocked(captureException).mockClear();
  const response = await fetch(`${origin}/v1/daemon/operations/createCorner`, {
    method: 'POST', headers: { authorization: 'Bearer bdt_refusal_fixture_123456789', 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  const opened = await response.json() as { cornerId: string };
  expect((await db.query('SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1', [opened.cornerId])).rows[0])
    .toMatchObject({ approval_basis: { kind: 'agent-initiated', approvedBy: agent, sourceMessageId: invalidApproval } });
  expect(captureException).not.toHaveBeenCalled();
  expect((await db.query('SELECT parent_id FROM rooms WHERE id=$1', [opened.cornerId])).rows[0]).toMatchObject({ parent_id: parent });
});

it.each([
  ['listAppTools', { roomId: parent, appId: '44444444-4444-4444-8444-444444444444' }, 503, 'Connected app is unavailable in this Room'],
  ['createCorner', { roomId: parent, name: 'missing-implementer', objective: 'Prove refusal', implementer: 'absent', brief: { spec: 'Prove refusal' } }, 503, 'implementer must be a current member of the parent Room'],
])('Reproduction SENTRY-REMAINING: %s preserves caller message without capture', async (operation, input, status, message) => {
  const source = operation === 'listAppTools' ? '3'.repeat(64) : '4'.repeat(64);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Prove refusal')`, [source, parent, owner]);
  const command = await createAgentCommand(db, { roomId: parent, agentId: agent, sourceMessageId: source, reason: 'human_tag' });
  await daemon.execute('claimAgentCommand', { roomId: parent, commandId: command!.id, generationId: 'remaining' }, agent);
  const authorizedInput = { ...input, requestId: command!.turn_request_id, generationId: 'remaining' };
  vi.mocked(captureException).mockClear();
  const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
    method: 'POST', headers: { authorization: 'Bearer bdt_refusal_fixture_123456789', 'content-type': 'application/json' }, body: JSON.stringify(authorizedInput),
  });
  expect(await response.json()).toEqual({ error: message });
  expect(response.status).toBe(status);
  expect(captureException).not.toHaveBeenCalled();
});

it('Reproduction SENTRY-R: start workflow with missing starter returns unchanged refusal without capture', async () => {
  const source = '5'.repeat(64);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Prove workflow refusal')`, [source, parent, owner]);
  const command = await createAgentCommand(db, { roomId: parent, agentId: agent, sourceMessageId: source, reason: 'human_tag' });
  await daemon.execute('claimAgentCommand', { roomId: parent, commandId: command!.id, generationId: 'role' }, agent);
  const turn = { roomId: parent, requestId: command!.turn_request_id, generationId: 'role' };
  await daemon.execute('saveWorkflow', { ...turn, contract: describedWorkflow({
    version: 1, name: 'refusal-proof', description: 'Prove missing starter refusal', roles: ['starter'], start: 'work',
    handoffs: { work: { role: 'starter', requires: ['summary'], on: { done: 'done' } }, done: { kind: 'terminal', status: 'done' } },
  }) } as never, agent);
  vi.mocked(captureException).mockClear();
  const response = await fetch(`${origin}/v1/daemon/operations/startWorkflow`, {
    method: 'POST', headers: { authorization: 'Bearer bdt_refusal_fixture_123456789', 'content-type': 'application/json' },
    body: JSON.stringify({ ...turn, name: 'refusal-proof', roleBindings: {} }),
  });
  expect(await response.json()).toEqual({ error: 'role binding is missing for starter' });
  expect(response.status).toBe(503);
  expect(captureException).not.toHaveBeenCalled();
});
