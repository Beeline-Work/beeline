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

it('Reproduction R1 / ask-refusal: corner brief and ask refusals do not reach Sentry; unexpected faults still report', async () => {
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
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, room, owner]);
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
    for (const ask of ['x'.repeat(141), '**Choose now?**', 'First? Second?', 'First\nSecond', 42, '']) {
      for (const operation of ['report', 'askRoomChoice']) {
        const refused = await post(operation, { ...turn, status: 'needs_decision', text: 'needs-decision: Choose now',
          prompt: 'Choose now?', options: [{ label: 'Yes', consequence: 'Continue' }, { label: 'No', consequence: 'Stop' }], ask });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toMatch(/^ask /);
      }
    }
    await Sentry.flush(2000);
    expect(envelopes.some(envelope => envelope.includes('"exception"'))).toBe(false);
    expect((await post('askRoomChoice', { ...turn, ask: 'x'.repeat(140), prompt: 'Choose now?',
      options: [{ label: 'Yes', consequence: 'Continue' }, { label: 'No', consequence: 'Stop' }] })).status).toBe(200);
    console.info('Demonstrated ask-refusal: malformed asks return 400 without Sentry events; the 140-character boundary is accepted');
    const brief = { spec: 'Keep the approved scope', approval: { sourceMessageId: source }, change: 'Clarify the scope' };
    const opened = await post('createCorner', { ...turn, name: 'Refusal-proof', objective: 'Prove revision refusals', brief });
    expect(opened.status).toBe(200);
    const cornerId = opened.body.cornerId;
    const revise = (overrides: Record<string, unknown> = {}) => post('reviseCornerBrief', {
      ...turn, cornerId, expectedRevision: 0, brief, ...overrides,
    });
    const events = () => envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))).filter(item => item.exception);
    const stale = await revise();
    await Sentry.flush(2000);
    console.log('R1 evidence', JSON.stringify({ stale, captured: events().length }));
    expect(stale).toEqual({ status: 409, body: { error: 'corner brief revision changed; read the current assignment' } });
    expect(events()).toHaveLength(0);
    expect(await revise({ brief: { ...brief, change: ' ' } })).toEqual({ status: 400,
      body: { error: 'corner brief revision requires a change description' } });
    expect(await revise({ cornerId: room })).toEqual({ status: 403,
      body: { error: 'corner brief revision denied' } });
    await Sentry.flush(2000);
    expect(events()).toHaveLength(0);
    await db.query('DROP TABLE corner_brief_revisions CASCADE');
    expect((await revise()).status).toBe(503);
    await Sentry.flush(2000);
    expect(events()).toHaveLength(1);
    expect(events()[0].exception.values[0].value).toContain('corner_brief_revisions');
  } finally {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    await Sentry.close(2000);
    await new Promise<void>(resolve => collector.close(() => resolve()));
  }
}, 60_000);
