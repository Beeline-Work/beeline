import { FEEDBACK_AGENT_DAILY_CAP } from '@beeline/api-contract/daemon';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/node';
import { expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { createAgentCommand, claimAgentCommand } from './agent-command.js';

it('Reproduction R1/R2: feedback overflow and workflow lookup produce no Sentry events; faults still report', async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.end('{}');
  });
  await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
  Sentry.init({ dsn: `http://public@127.0.0.1:${(collector.address() as AddressInfo).port}/1`,
    defaultIntegrations: false, skipOpenTelemetrySetup: true });
  const db = new PgliteDatabase();
  const owner = 'a'.repeat(64), agent = 'b'.repeat(64), source = 'c'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const live = new LiveHub();
  const daemon = new DaemonService(db, live);
  vi.spyOn(daemon, 'warmConnectorIndex').mockResolvedValue();
  const server = createBeelineServer({ database: db, daemon, live,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }),
    phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Agent')`, [owner, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, room, agent]);
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_refusal_fixture_123456789'), agent]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Run proof')`, [source, room, owner]);
    const command = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: source, reason: 'human_tag' });
    await claimAgentCommand(db, room, agent, command!.id, 'proof');
    const turn = { roomId: room, requestId: command!.turn_request_id, generationId: 'proof' };
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const post = async (operation: string, input: unknown) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/daemon/operations/${operation}`, {
        method: 'POST', headers: { authorization: 'Bearer bdt_refusal_fixture_123456789', 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    };
    for (let index = 0; index < FEEDBACK_AGENT_DAILY_CAP; index++) {
      expect((await post('reportFeedback', { ...turn, category: 'bug', summary: `Unique feedback ${index}` })).status).toBe(200);
    }
    const cap = await post('reportFeedback', { ...turn, category: 'bug', summary: 'Over daily cap' });
    const missing = await post('getWorkflowRun', { roomId: room, runId: 'deadbeef' });
    await Sentry.flush(2000);
    const events = () => envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))).filter(item => item.exception);
    console.log('R1/R2 evidence', JSON.stringify({ cap, missing, captured: events().length }));
    expect(cap).toEqual({ status: 200, body: { itemId: expect.stringMatching(/^fb_/), duplicate: false } });
    const repeatedOverflow = await post('reportFeedback', { ...turn, category: 'bug', summary: 'Latest excess report' });
    expect(repeatedOverflow).toEqual({ status: 200, body: { itemId: cap.body.itemId, duplicate: true } });
    expect(missing).toEqual({ status: 404, body: { error: 'workflow run is unavailable in this Room' } });
    // Full IDs skip prefix resolution and reach the read/mutation lookups.
    const fullMissingId = 'deadbeef' + '0'.repeat(56);
    for (const [operation, input] of [
      ['getWorkflowRun', { roomId: room, runId: fullMissingId }],
      ['cancelWorkflowRun', { ...turn, runId: fullMissingId, reason: 'Missing run proof' }],
    ] as const) {
      const result = await post(operation, input);
      console.log('R2 full-ID HTTP evidence', JSON.stringify({ operation, ...result }));
      expect(result).toEqual({ status: 503,
        body: { error: 'workflow run is unavailable in this Room' } });
      await Sentry.flush(2000);
      expect(events()).toHaveLength(0);
    }
    for (const [runId, message] of [
      ['', 'runId is required'],
      ['short', 'workflow run ID prefixes must contain at least 8 characters'],
    ]) {
      expect(await post('getWorkflowRun', { roomId: room, runId })).toEqual({ status: 400, body: { error: message } });
    }
    const ids = ['deadbeef' + '1'.repeat(56), 'deadbeef' + '2'.repeat(56)];
    for (const id of ids) await db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card) VALUES($1,$2,$3,'','workflow-handoff',$4::jsonb)`, [id, room, agent, JSON.stringify({ runId: id })]);
    expect(await post('getWorkflowRun', { roomId: room, runId: 'deadbeef' })).toEqual({ status: 400,
      body: { error: `workflow run ID prefix is ambiguous: ${ids.join(', ')}` } });
    await Sentry.flush(2000);
    expect(events()).toHaveLength(0);
    vi.spyOn(daemon, 'execute').mockRejectedValueOnce(new Error('Unexpected refusal proof fault'));
    expect((await post('getWorkflowRun', { roomId: room, runId: 'deadbeef' })).status).toBe(503);
    await Sentry.flush(2000);
    expect(events()).toHaveLength(1);
    expect(events()[0].exception.values[0].value).toBe('Unexpected refusal proof fault');
  } finally {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    await Sentry.close(2000);
    await new Promise<void>(resolve => collector.close(() => resolve()));
  }
}, 60_000);
