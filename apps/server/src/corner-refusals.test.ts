import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { CommandRefusalError } from './commander.js';
import { CornerVerdictRejectedError } from './corner-merge-approval.js';
import { captureServerError } from './sentry.js';

vi.mock('./sentry.js', () => ({ captureServerError: vi.fn() }));
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
  vi.mocked(captureServerError).mockClear();
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
  expect(captureServerError).not.toHaveBeenCalled();
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
