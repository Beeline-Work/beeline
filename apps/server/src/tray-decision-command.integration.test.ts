import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_COMPLETION_CHANNEL } from './command-completion.js';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { postRoomChoice } from './room-choice.js';
import { CommandDigestConflict, InvalidCommandArguments, RouterCommandLedger } from './router-command-ledger.js';
import { describedWorkflow, migratedDatabase, type PgliteDatabase } from "../../../tests/helpers/server.js";
import { dispatchTrayDecisionCommand, isTrayDecisionCommand, type TrayDecisionOperation } from './tray-decision-command.js';
import { TRAY_MUTABLE_SOURCE_SCHEMA } from './tray-mutable-source.js';
import { getWorkflowRun, saveWorkflow, startWorkflow } from './workflow-runs.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), AGENT = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333', GRANT = '44444444-4444-4444-8444-444444444444';
const APP = '55555555-5555-4555-8555-555555555555';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('durable DB-only Tray decision adapter', () => {
  let db: PgliteDatabase, live: LiveHub, phone: PhoneService;
  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query(TRAY_MUTABLE_SOURCE_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'human','Member','member'),($3,'agent','Agent','agent')`, [A, B, AGENT]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [AGENT, A]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic decisions')`, [W]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$3,'Origin',$4),($2,$3,'Private card',$4)`, [ROOM, OTHER, W, A]);
    for (const person of [A, B, AGENT]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$4,$5),($1,$2,$4,'member'),($1,$3,$4,'member')`, [W, ROOM, OTHER, person, person === A ? 'owner' : 'member']);
    live = new LiveHub();
    phone = new PhoneService(db, 'https://synthetic.invalid', undefined, undefined, live);
  });
  afterEach(async () => { await db.close(); });
  const dispatch = (operation: TrayDecisionOperation, input: Record<string, unknown>, id: string, viewer = A, database: SqlDatabase = db) =>
    dispatchTrayDecisionCommand(new RouterCommandLedger(database), phone, live, operation, input, viewer, { v: 1, id });
  async function grant(kind = 'path', target = '/synthetic', appId: string | null = null) {
    await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status,app_id)
      VALUES($1,$2,$3,$4,$5,$6,'Synthetic request',$7,'pending',$8)`, [GRANT, AGENT, W, ROOM, kind, target, A, appId]);
    for (const [message, room] of [['d'.repeat(64), ROOM], ['e'.repeat(64), OTHER]]) await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Synthetic ask','card','grant-request',$4::jsonb)`,
      [message, room, AGENT, JSON.stringify({ grants: [{ grantId: GRANT, status: 'pending', kind, target }] })]);
  }
  async function permission(spending = false) {
    await db.query(`INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
      VALUES('permission',$1,$2,'request','{}','pending')`, [ROOM, B]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Synthetic permission','card','permission',$4::jsonb)`, ['f'.repeat(64), ROOM, AGENT,
      JSON.stringify({ permissionId: 'permission', requestId: 'request', agent: { pubkey: AGENT }, repository: 'synthetic/repo', status: 'pending',
        ...(spending ? { purpose: 'squire-spending' } : {}) })]);
    return { roomId: ROOM, permissionId: 'permission', requestId: 'request', agentId: AGENT, repository: 'synthetic/repo', decision: 'allow' };
  }
  const status = async () => (await db.query<{ status: string }>('SELECT status FROM agent_grants WHERE id=$1', [GRANT])).rows[0]?.status;

  it('commits one grant decision and outcome-only receipt, replays after revocation without notifications or DTO reads', async () => {
    await grant();
    // Owning a personal resource does not require membership in its source Room.
    await db.query('DELETE FROM memberships WHERE identity_id=$1 AND room_id=$2', [A, ROOM]);
    const publish = vi.spyOn(live, 'publish');
    const input = { grantId: GRANT, decision: 'once' };
    const receipt = await dispatch('decideAgentGrant', input, 'grant-once');
    expect(receipt).toEqual({ v: 1, operation: 'decideAgentGrant', commandId: 'grant-once', state: 'committed', result: null });
    expect(await status()).toBe('once');
    expect((await db.query(`SELECT count(*)::int count FROM messages WHERE card_type='grant-decision'`)).rows[0]?.count).toBe(1);
    expect(publish.mock.calls.map(([event]) => [event.roomId, event.type === 'invalidate' ? event.reason : null]))
      .toEqual([[OTHER, 'grant'], [ROOM, 'phone-write']]);
    publish.mockClear();
    await db.query('UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND workspace_id=$2', [A, W]);
    const queries: string[] = [];
    const observe = (database: SqlDatabase): SqlDatabase => ({
      query: (sql, values) => { queries.push(sql); return database.query(sql, values); },
      transaction: work => database.transaction(tx => work(observe(tx))),
    });
    expect(await dispatch('decideAgentGrant', input, 'grant-once', A, observe(db))).toEqual(receipt);
    expect(queries.some(sql => /readNeedsYou|FROM rooms|FROM agent_grants|FROM permission_authority/.test(sql))).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    await expect(dispatch('decideAgentGrant', { ...input, decision: 'deny' }, 'grant-once')).rejects.toBeInstanceOf(CommandDigestConflict);
  });

  it('holds queued compatibility notifications until the actual outer commit and discards them on rollback', async () => {
    await grant();
    const publish = vi.spyOn(live, 'publish'), completion = vi.fn();
    const stop = await db.client.listen(COMMAND_COMPLETION_CHANNEL, completion);
    const reached = deferred(), release = deferred();
    let insideStatus: unknown;
    const held: SqlDatabase = { query: (sql, values) => db.query(sql, values), transaction: work => db.transaction(async tx => {
      await work(tx);
      insideStatus = (await tx.query('SELECT status FROM agent_grants WHERE id=$1', [GRANT])).rows[0]?.status;
      reached.resolve(); await release.promise; throw new Error('synthetic outer rollback');
    }) };
    const attempt = dispatch('decideAgentGrant', { grantId: GRANT, decision: 'always' }, 'rollback', A, held);
    const rejected = expect(attempt).rejects.toThrow('synthetic outer rollback');
    try {
      await reached.promise;
      expect(insideStatus).toBe('approved');
      expect(publish).not.toHaveBeenCalled(); expect(completion).not.toHaveBeenCalled();
      release.resolve(); await rejected;
      expect(await status()).toBe('pending');
      expect((await db.query('SELECT * FROM router_commands')).rows).toEqual([]);
      expect((await db.query(`SELECT id FROM messages WHERE card_type='grant-decision'`)).rows).toEqual([]);
      expect(publish).not.toHaveBeenCalled(); expect(completion).not.toHaveBeenCalled();
    } finally { release.resolve(); await rejected; await stop(); }
  });

  it('keeps connected-person app authority and rejects Workspace-manager substitution', async () => {
    await db.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
      VALUES($1,$2,$3,'synthetic','Synthetic','registry-mcp','registry-mcp')`, [APP, W, B]);
    await grant('mcp', 'connection-install:synthetic', APP);
    await expect(dispatch('decideAgentGrant', { grantId: GRANT, decision: 'always' }, 'wrong-connected-person')).rejects.toThrow('connected person');
    expect(await status()).toBe('pending');
    await dispatch('decideAgentGrant', { grantId: GRANT, decision: 'always' }, 'connected-person', B);
    expect(await status()).toBe('approved');
  });

  it('refuses superseded grants and shared-asset Once without a receipt or wake', async () => {
    await grant('shared_asset', 'package-cache');
    await expect(dispatch('decideAgentGrant', { grantId: GRANT, decision: 'once' }, 'shared-once')).rejects.toThrow('standing approval');
    await db.query('UPDATE agent_grants SET superseded_at=now() WHERE id=$1', [GRANT]);
    await expect(dispatch('decideAgentGrant', { grantId: GRANT, decision: 'always' }, 'superseded')).rejects.toThrow('superseded');
    expect(await status()).toBe('pending');
    expect((await db.query('SELECT * FROM router_commands')).rows).toEqual([]);
    expect((await db.query(`SELECT id FROM messages WHERE card_type='grant-decision'`)).rows).toEqual([]);
  });

  it('settles an exact permission once and refuses mismatched request/card fields before mutation', async () => {
    const input = await permission();
    await expect(dispatch('decideWritePermission', { ...input, requestId: 'old' }, 'wrong-request')).rejects.toThrow('invalid');
    const receipt = await dispatch('decideWritePermission', input, 'permission');
    const publish = vi.spyOn(live, 'publish');
    expect(await dispatch('decideWritePermission', input, 'permission')).toEqual(receipt);
    expect(publish).not.toHaveBeenCalled();
    expect((await db.query('SELECT status FROM permission_authority')).rows).toEqual([{ status: 'authorized' }]);
    expect((await db.query(`SELECT count(*)::int count FROM messages WHERE card_type='permission' AND card->>'status'='allowed'`)).rows[0]?.count).toBe(1);
  });

  it('preserves spending-owner-only authority even for a Workspace manager', async () => {
    const input = await permission(true);
    await db.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1', [AGENT, B]);
    await expect(dispatch('decideWritePermission', input, 'not-spending-owner')).rejects.toThrow();
    expect((await db.query('SELECT status FROM permission_authority')).rows).toEqual([{ status: 'pending' }]);
    await dispatch('decideWritePermission', input, 'spending-owner', B);
    expect((await db.query('SELECT status FROM permission_authority')).rows).toEqual([{ status: 'authorized' }]);
  });

  it('skips an actual ordinary choice once and refuses a due choice before its expiry worker runs', async () => {
    const create = () => db.transaction(tx => postRoomChoice(tx, { roomId: ROOM, agentId: AGENT, mode: 'question', prompt: 'Synthetic?',
      options: [{ label: 'One', consequence: 'Use one' }, { label: 'Two', consequence: 'Use two' }], ttlSeconds: 300 }));
    const choice = await create();
    const input = { choiceId: choice.choiceId };
    const receipt = await dispatch('skipChoice', input, 'skip');
    expect(await dispatch('skipChoice', input, 'skip')).toEqual(receipt);
    expect((await db.query('SELECT status FROM room_choices WHERE id=$1', [choice.choiceId])).rows).toEqual([{ status: 'skipped' }]);
    expect((await db.query(`SELECT count(*)::int count FROM messages WHERE card_type='choice-skipped'`)).rows[0]?.count).toBe(1);
    const expired = await create();
    await db.query(`UPDATE room_choices SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [expired.choiceId]);
    await expect(dispatch('skipChoice', { choiceId: expired.choiceId }, 'due')).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT status FROM room_choices WHERE id=$1', [expired.choiceId])).rows).toEqual([{ status: 'open' }]);
  });

  it('takes a real workflow gate default once without advancing the run again on receipt replay', async () => {
    const contract = describedWorkflow({ version: 1, name: 'tray-gate', description: 'A synthetic human decision',
      roles: ['approver'], start: 'decision', deadlineSeconds: 7200, handoffs: {
        decision: { kind: 'gate', role: 'approver', requires: ['decision'], on: { approve: 'done', stop: 'failed' }, timeoutSeconds: 600, default: 'stop' },
        done: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      } });
    await saveWorkflow(db, { room_id: ROOM, agent_id: AGENT } as CommandRow, { contract });
    const { runId } = await startWorkflow(db, { room_id: ROOM, agent_id: A } as CommandRow,
      { name: 'tray-gate', roleBindings: { approver: AGENT } });
    const choice = (await db.query<{ id: string; options: { label: string }[] }>(`SELECT choice.id,choice.options FROM room_choices choice JOIN messages message ON message.id=choice.message_id
      WHERE message.card->>'runId'=$1 AND choice.status='open'`, [runId])).rows[0]!;
    expect(choice.options.map(option => option.label).sort()).toEqual(['approve', 'stop']);
    expect(await getWorkflowRun(db, ROOM, runId)).toMatchObject({ state: 'decision', attempt: 0 });
    const receipt = await dispatch('skipChoice', { choiceId: choice.id }, 'gate-default');
    expect(await dispatch('skipChoice', { choiceId: choice.id }, 'gate-default')).toEqual(receipt);
    expect(await getWorkflowRun(db, ROOM, runId)).toMatchObject({ state: 'failed', attempt: 1 });
    expect((await db.query(`SELECT count(*)::int count FROM messages WHERE card_type='workflow-handoff' AND card->>'runId'=$1`, [runId])).rows[0]?.count).toBe(2);
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`, [choice.id])).rows).toEqual([{ status: 'skipped' }]);
    expect((await db.query(`SELECT card->>'outcome' outcome,card->'contents' contents FROM messages
      WHERE card_type='workflow-handoff' AND card->>'runId'=$1 AND card->>'seq'='1'`, [runId])).rows)
      .toEqual([{ outcome: 'stop', contents: { decision: 'stop', defaultedBy: A } }]);
  });

  it('keeps legacy result/receipt behavior and refuses answerChoice or malformed selected inputs', async () => {
    expect(isTrayDecisionCommand('answerChoice')).toBe(false);
    expect(isTrayDecisionCommand('skipChoice')).toBe(true);
    await grant();
    const getter = vi.fn(() => GRANT);
    const input = { decision: 'deny' } as Record<string, unknown>;
    Object.defineProperty(input, 'grantId', { get: getter, enumerable: true });
    await expect(dispatch('decideAgentGrant', input, 'getter')).rejects.toBeInstanceOf(InvalidCommandArguments);
    expect(getter).not.toHaveBeenCalled();
    await expect(dispatch('decideAgentGrant', { grantId: GRANT, decision: 'deny', metadata: 'extra' }, 'extra')).rejects.toBeInstanceOf(InvalidCommandArguments);
    await expect(dispatchTrayDecisionCommand(new RouterCommandLedger(db), phone, live, 'answerChoice' as TrayDecisionOperation,
      { choiceId: GRANT, optionId: 'B' }, A, { v: 1, id: 'provider' })).rejects.toMatchObject({ status: 400 });
    const result = await phone.execute('decideAgentGrant', { grantId: GRANT, decision: 'deny' }, A);
    expect(result).toEqual({ grantId: GRANT, status: 'denied', roomId: ROOM });
    expect((await db.query('SELECT * FROM router_commands')).rows).toEqual([]);
  });
});
