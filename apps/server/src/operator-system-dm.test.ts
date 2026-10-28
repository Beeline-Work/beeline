import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { migrate, PostgresDatabase } from './database.js';
import { BackgroundJobRunner } from './background.js';
import * as sentry from './sentry.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { OPERATOR_OWNER_ID as OWNER, flushOperatorSystemDms } from './operator-system-dm.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { PhoneService } from './phone-service.js';

const AGENT = 'c'.repeat(64), PERSON = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase, daemon: DaemonService;
let seq = 0;
beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Operator','lunchboxfortwo'),($2,'agent','Worker','worker'),
    ($3,'human','Recipient','recipient'),($4,'human','Other','other')`, [OWNER, AGENT, PERSON, OTHER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Test')`, [ROOM, WORKSPACE, OWNER]);
  for (const id of [OWNER, AGENT, PERSON, OTHER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WORKSPACE, id, ROOM]);
  daemon = new DaemonService(db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
    undefined, undefined, { enabled: false }, undefined, undefined, undefined,
    { config: { repository: 'Beeline-Work/beeline', systemSenders: [OWNER, OTHER] } });
});
afterEach(async () => { await db.close(); });
async function turn(author = OWNER) {
  const id = (++seq).toString(16).padStart(64, '0');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Send the test notice')`, [id, ROOM, author]);
  const requestId = `request-${seq}`, generationId = `generation-${seq}`;
  const command = await createAgentCommand(db, { roomId: ROOM, agentId: AGENT, sourceMessageId: id, reason: 'human_tag', turnRequestId: requestId });
  await claimAgentCommand(db, ROOM, AGENT, command!.id, generationId);
  return { agentId: AGENT, roomId: ROOM, requestId, generationId };
}
async function send(recipients: string | string[], text = 'Your issue has been fixed.') {
  return daemon.execute('sendOperatorSystemDm', { ...await turn(), recipients, text }, AGENT);
}
async function drain() { while (await flushOperatorSystemDms(db)) { /* Drain bounded batches in this isolated fixture. */ } }

describe('owner-command operator System DMs', () => {
  it('R-SENTRY-CONNECT: a deferred checkout preserves the notice and delivers it once on the next loop', async () => {
    const text = 'Your notice is ready.';
    const sent = await send('@recipient', text);
    const client = Object.assign(new EventEmitter(), {
      query: (sql: string, values?: unknown[]) => db.query(sql, values),
      release: vi.fn(),
    });
    const connect = vi.fn().mockResolvedValue(client);
    for (let i = 0; i < 4; i++) connect.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    const database = new PostgresDatabase('', 1, {
      pool: { connect, on: vi.fn(), end: vi.fn() } as unknown as Pool, pause: async () => {},
    });
    const capture = vi.spyOn(sentry, 'captureServerError').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = new BackgroundJobRunner();
      const run = () => runner.run('operator-system-dms', () => flushOperatorSystemDms(database));
      expect(await run()).toEqual({ ok: false });
      expect((await db.query('SELECT state FROM operator_system_dm_deliveries WHERE send_id=$1', [sent.sendId])).rows)
        .toEqual([{ state: 'pending' }]);
      expect(capture).not.toHaveBeenCalled();
      expect(await run()).toEqual({ ok: true, value: 1 });
      expect(await run()).toEqual({ ok: true, value: 0 });
      expect((await db.query('SELECT state FROM operator_system_dm_deliveries WHERE send_id=$1', [sent.sendId])).rows)
        .toEqual([{ state: 'delivered' }]);
      const messages = (await db.query<{ room_id: string }>('SELECT room_id FROM messages WHERE author_id=$1 AND text=$2',
        [SYSTEM_IDENTITY_ID, text])).rows;
      expect(messages).toHaveLength(1);
      const view = await new PhoneService(db, new LiveHub()).readRoom(messages[0]!.room_id, PERSON);
      expect(view!.messages.some(message => message.text === text)).toBe(true);
    } finally {
      capture.mockRestore();
      warning.mockRestore();
    }
  });
  it('refuses a missing command, non-owner root, wrong agent owner, and stale generation', async () => {
    await expect(daemon.execute('sendOperatorSystemDm', { agentId: AGENT, roomId: ROOM, requestId: 'absent', recipients: PERSON, text: 'hello' }, AGENT)).rejects.toThrow();
    await expect(daemon.execute('sendOperatorSystemDm', { ...await turn(OTHER), recipients: PERSON, text: 'hello' }, AGENT)).rejects.toThrow(/operator owner/);
    const current = await turn();
    await expect(daemon.execute('sendOperatorSystemDm', { ...current, generationId: 'stale', recipients: PERSON, text: 'hello' }, AGENT)).rejects.toThrow();
    await db.query(`UPDATE agents SET owner_id=$1 WHERE agent_id=$2`, [OTHER, AGENT]);
    await expect(daemon.execute('sendOperatorSystemDm', { ...current, recipients: PERSON, text: 'hello' }, AGENT)).rejects.toThrow(/operator owner/);
    expect((await db.query(`SELECT * FROM operator_system_dm_sends`)).rowCount).toBe(0);
  });
  it('queues a single exact handle, audits it, and the recipient reads the System message', async () => {
    const text = 'Your issue has been fixed.\nYou can use Beeline again.';
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
      VALUES('operator-proof-device',$1,'android','physical',now()-interval '1 minute')`, [PERSON]);
    await db.query(`INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 minute')
      ON CONFLICT(id) DO UPDATE SET started_at=EXCLUDED.started_at`);
    const sent = await send('@recipient', text);
    expect(sent).toMatchObject({ recipients: 1, delivered: 0, failed: 0, pending: 1 });
    await drain();
    const result = await daemon.execute('readOperatorSystemDm', { ...await turn(), sendId: sent.sendId }, AGENT);
    expect(result).toMatchObject({ recipients: 1, delivered: 1, failed: 0, pending: 0 });
    const audit = (await db.query(`SELECT * FROM operator_system_dm_sends WHERE id=$1`, [sent.sendId])).rows[0]!;
    expect(audit).toMatchObject({ caller_id: AGENT, owner_id: OWNER, text_hash: createHash('sha256').update(text).digest('hex'), recipients: ['recipient'], recipient_count: 1 });
    expect(audit.source_message_id).toBeTruthy();
    expect(audit.created_at).toBeTruthy();
    const message = (await db.query<{ room_id: string }>(`SELECT room_id FROM messages WHERE author_id=$1 AND text=$2`, [SYSTEM_IDENTITY_ID, text])).rows[0]!;
    expect((await db.query(`SELECT o.message_id FROM push_outbox o JOIN messages m ON m.id=o.message_id
      WHERE o.device_token='operator-proof-device' AND m.author_id=$1 AND m.text=$2`, [SYSTEM_IDENTITY_ID, text])).rowCount).toBe(1);
    const view = await new PhoneService(db, new LiveHub()).readRoom(message.room_id, PERSON);
    expect(view!.messages.some(message => message.text === text && message.author.pubkey === SYSTEM_IDENTITY_ID)).toBe(true);
    await drain();
    expect((await db.query(`SELECT id FROM messages WHERE author_id=$1 AND text=$2`, [SYSTEM_IDENTITY_ID, text])).rowCount).toBe(1);
  });
  it('deduplicates list recipients resolved by both id and handle', async () => {
    const sent = await send([PERSON, '@recipient', OTHER]);
    await drain();
    expect((await db.query(`SELECT state FROM operator_system_dm_deliveries WHERE send_id=$1`, [sent.sendId])).rows).toEqual([{ state: 'delivered' }, { state: 'delivered' }]);
    expect(sent.recipients).toBe(2);
  });
  it('snapshots all human users, excluding hidden System identities and agents', async () => {
    const sent = await send('all');
    expect(sent.recipients).toBe(3);
    await drain();
    expect((await db.query(`SELECT state FROM operator_system_dm_deliveries WHERE send_id=$1 AND state='delivered'`, [sent.sendId])).rowCount).toBe(3);
    expect((await db.query(`SELECT recipients FROM operator_system_dm_sends WHERE id=$1`, [sent.sendId])).rows[0]!.recipients).toBe('all');
  });
  it('reports a partial failure and keeps delivering other recipients', async () => {
    const sent = await send([PERSON, OTHER]);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [OTHER]);
    await drain();
    const result = await daemon.execute('readOperatorSystemDm', { ...await turn(), sendId: sent.sendId }, AGENT);
    expect(result).toMatchObject({ recipients: 2, delivered: 1, failed: 1, pending: 0 });
  });
  it('bounds each worker batch and resumes the persisted queue', async () => {
    for (let n = 0; n < 12; n++) {
      const id = (100 + n).toString(16).padStart(64, '0');
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human',$1,$1)`, [id]);
      await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, id]);
    }
    const sent = await send('all');
    const first = await flushOperatorSystemDms(db);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(10);
    let status = await daemon.execute('readOperatorSystemDm', { ...await turn(), sendId: sent.sendId }, AGENT);
    expect(status.pending).toBeGreaterThan(0);
    await drain();
    status = await daemon.execute('readOperatorSystemDm', { ...await turn(), sendId: sent.sendId }, AGENT);
    expect(status).toMatchObject({ recipients: 15, delivered: 15, failed: 0, pending: 0 });
  });
  it('counts humans without an active Workspace as failed recipients', async () => {
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [OTHER]);
    const sent = await send(OTHER);
    expect(sent).toMatchObject({ recipients: 1, failed: 1, pending: 0 });
  });
  it('accepts normal message lengths and rejects overlong text or inexact recipients', async () => {
    await expect(send(PERSON, 'x'.repeat(16000))).resolves.toMatchObject({ recipients: 1 });
    await expect(send(PERSON, 'x'.repeat(16001))).rejects.toThrow(/16000/);
    await expect(send('recip')).rejects.toThrow(/exact human/);
  });
});
