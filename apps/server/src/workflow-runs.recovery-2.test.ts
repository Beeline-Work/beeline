import { HelperDaemonService, normalizeLegacyWorkflowRuns, saveUnsavedWorkflowRunStatus, workflowRunIsLiveSql, workflowRunStatusUnsavedSql, LiveHub, describedWorkflow, randomUUID, describe, expect, it, vi, migrateData, postRoomChoice, assignWorkflowRole, handoff, getWorkflowRun, saveWorkflow, startWorkflow, APPROVER, GATED, OWNER, ROOM, RecordingDatabase, WORKER_A, WORKER_B, WORKSPACE, adminCommand, answerGate, commandFor, database, reachGate, startedGatedRun, startedListRun, fixtureScope10, fixtureScope11, type CommandRow } from './workflow-runs.recovery.test-support.js';

describe('Reproduction workflow-stalls', () => {

  it('opens gates beside an ask_choice and another workflow gate while preserving the ordinary choice limit', async () => {
    const ordinary = () => postRoomChoice(database, { roomId: ROOM, agentId: APPROVER,
      mode: 'question', prompt: 'Which plan?', options: [{ label: 'First', consequence: 'Use first plan' }, { label: 'Second', consequence: 'Use second plan' }] });
    await ordinary();
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow({ ...GATED, name: 'second-gate' }) });
    const second = await startWorkflow(database, await commandFor(WORKER_A), {
      name: 'second-gate', roleBindings: { worker: WORKER_A, approver: APPROVER },
    });
    await reachGate(second.runId);
    expect((await database.query(`SELECT id FROM room_choices WHERE status='open' AND agent_id=$1`, [APPROVER])).rowCount).toBe(3);
    await expect(ordinary()).rejects.toThrow('already have an open choice');
    console.log('Demonstrated workflow-stalls-2: two gates and one ordinary choice coexist; another ordinary choice is refused');
  });


  it('commits a completed turn even when its workflow contract is missing', async () => {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,[WORKSPACE,WORKER_A]);
    const { runId } = await startedListRun();
    const command = (await database.query<CommandRow>(`SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [runId, WORKER_A])).rows[0]!;
    const generationId = 'workflow-stalls-3';
    const daemon = new HelperDaemonService(database, new LiveHub());
    await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: command.id, generationId }, WORKER_A);
    await database.query(`DELETE FROM workspace_skills WHERE slug='list-flow'`);
    await daemon.execute('postAgentTurnReceipt', { roomId: ROOM, requestId: command.turn_request_id,
      generationId, status: 'complete' }, WORKER_A);
    expect((await database.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0]).toMatchObject({ state: 'complete' });
    expect((await database.query(`SELECT status FROM agent_turns WHERE request_id=$1`, [command.turn_request_id])).rows[0]).toMatchObject({ status: 'complete' });
    console.log('Demonstrated workflow-stalls-3: missing contract did not prevent the completion receipt or command completion');
  });


  it.each(['server', 'waiting', 'roleBinding', 'implicitEdges', 'externalOutcomes'])('rejects corner-only %s on save', async (field) => {
    const contract = describedWorkflow(GATED) as any;
    if (field === 'server') contract.handoffs.work = { kind: 'server', does: 'Run', requires: [], on: { done: 'sign_off' } };
    if (field === 'waiting') {
      contract.handoffs.sign_off = { kind: 'waiting', does: 'Wait' };
      contract.handoffs.work.on = { done: 'sign_off', finished: 'land', timeout: 'failed' };
    }
    if (field === 'roleBinding') contract.handoffs.work.roleBinding = 'live:parent.worker_agent_id';
    if (field === 'implicitEdges') contract.implicitEdges = ['land'];
    if (field === 'externalOutcomes') contract.externalOutcomes = ['done'];
    await expect(saveWorkflow(database, await commandFor(WORKER_A), { contract })).rejects.toThrow(/corner-only/);
    console.log(`Demonstrated workflow-stalls-4: save rejected ${field}`);
  });
});
describe('workflow cleanup migration', () => {
  it('Reproduction cleanup-transaction: a SQL recovery error leaves other runs and the startup marker intact', async () => {
    const failed = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    const { runId: healthy } = await startedListRun();
    await database.query(`DELETE FROM workflow_backfills WHERE name='workflow-storage-v1'`);
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=ANY($1::text[])`, [[failed, healthy]]);
    await database.query(`CREATE FUNCTION reject_gated_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.workflow_run->>'workflowSlug' = 'gated' THEN
          RAISE EXCEPTION 'broken run recovery' USING ERRCODE = '22000';
        END IF;
        RETURN NEW;
      END $$`);
    await database.query(`CREATE TRIGGER reject_gated_recovery BEFORE INSERT ON agent_schedules
      FOR EACH ROW EXECUTE FUNCTION reject_gated_recovery()`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await migrateData(database);
      expect(errors).toHaveBeenCalledWith(
        `backfillWorkflowRunTimers: failed to recover run ${failed}`,
        expect.objectContaining({ code: '22000' }),
      );
      expect((await database.query(`SELECT workflow_run->>'timer' timer FROM agent_schedules
        WHERE workflow_run->>'runId'=$1 ORDER BY timer`, [healthy])).rows)
        .toEqual([{ timer: 'deadline' }, { timer: 'step' }]);
      expect((await database.query(`SELECT id FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [failed])).rows).toEqual([]);
      expect((await database.query(`SELECT name FROM workflow_backfills WHERE name='workflow-storage-v1'`)).rows)
        .toEqual([{ name: 'workflow-storage-v1' }]);
      const failures = errors.mock.calls.length;
      await migrateData(database);
      // Timer recovery runs every boot, so only the broken run is retried.
      expect(errors.mock.calls.slice(failures)).toEqual([
        [`backfillWorkflowRunTimers: failed to recover run ${failed}`, expect.objectContaining({ code: '22000' })],
      ]);
      expect((await database.query(`SELECT workflow_run->>'timer' timer FROM agent_schedules
        WHERE workflow_run->>'runId'=$1 ORDER BY timer`, [healthy])).rows)
        .toEqual([{ timer: 'deadline' }, { timer: 'step' }]);
      console.log('Demonstrated cleanup-transaction: startup isolated a real SQL error, recovered the healthy run, and persisted its completion marker');
    } finally {
      errors.mockRestore();
    }
  });


  it('Demonstrated cleanup-storage: migrates every legacy shape once and a person can still answer the live gate', async () => {
    const ended = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(ended);
    await answerGate(ended, 'publish');
    const live = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(live);
    await database.query(`DELETE FROM workflow_backfills WHERE name='workflow-storage-v1'`);
    await database.query(`UPDATE messages SET card=card-'runStatus' || '{"active":true}'::jsonb WHERE id=ANY($1::text[])`, [[ended, live]]);
    await database.query(`UPDATE messages SET card=card-'seq' WHERE card_type='workflow-handoff' AND card->>'runId'=$1`, [live]);
    // This fixture predates readable gate prompts as well as attempt metadata.
    await database.query(`UPDATE room_choices SET prompt='gated: sign_off'
      WHERE message_id IN (SELECT id FROM messages WHERE card->>'runId'=$1)`, [live]);
    await database.query(`UPDATE messages SET card=card-'attempt' WHERE id IN (SELECT message_id FROM room_choices) AND card->>'runId'=$1`, [live]);
    const oldId = randomUUID();
    await database.query(`UPDATE agent_schedules SET id=$2,workflow_run=workflow_run-'timer'-'attempt'
      WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='step'`, [live, oldId]);
    const due = (await database.query(`SELECT next_run_at FROM agent_schedules WHERE id=$1`, [oldId])).rows[0]!;
    const commandsBefore = (await database.query(`SELECT * FROM agent_commands ORDER BY id`)).rows;
    await migrateData(database);
    expect((await database.query(`SELECT id,card->>'runStatus' run_status,card ? 'active' active FROM messages WHERE id=ANY($1::text[]) ORDER BY id`, [[ended, live]])).rows)
      .toEqual([{ id: ended, run_status: 'done', active: false }, { id: live, run_status: 'live', active: false }].sort((a,b) => a.id.localeCompare(b.id)));
    expect((await database.query(`SELECT card->>'seq' seq FROM messages WHERE card_type='workflow-handoff' AND card->>'runId'=$1 ORDER BY (card->>'seq')::int`, [live])).rows)
      .toEqual([{ seq: '-1' }, { seq: '0' }]);
    const timer = (await database.query<{ id: string; next_run_at: Date; workflow_run: unknown }>(`SELECT id,next_run_at,workflow_run FROM agent_schedules
      WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='step'`, [live])).rows[0]!;
    expect(timer.id).not.toBe(oldId);
    expect(timer.next_run_at).toEqual(due.next_run_at);
    expect(timer.workflow_run).toMatchObject({ timer: 'step', attempt: 0 });
    expect((await database.query(`SELECT * FROM agent_commands ORDER BY id`)).rows).toEqual(commandsBefore);
    expect(await getWorkflowRun(database, ROOM, live)).toMatchObject({ state: 'sign_off', status: 'live', attempt: 0 });
    const snapshot = async () => ({
      messages: (await database.query(`SELECT id,card FROM messages WHERE card->>'runId'=ANY($1::text[]) ORDER BY id`, [[ended, live]])).rows,
      timers: (await database.query(`SELECT * FROM agent_schedules ORDER BY id`)).rows,
    });
    const once = await snapshot();
    await normalizeLegacyWorkflowRuns(database);
    expect(await snapshot()).toEqual(once);
    const recorded = new RecordingDatabase(database);
    await migrateData(recorded);
    expect(await snapshot()).toEqual(once);
    expect(recorded.calls.some(({ sql }) => sql.includes('WITH missing AS') || sql.includes('FROM room_choices choice JOIN messages choicemsg'))).toBe(false);
    await answerGate(live, 'publish');
    expect(await getWorkflowRun(database, ROOM, live)).toMatchObject({ status: 'done' });
    console.log('Demonstrated cleanup-storage: legacy live gate kept its lease and received no new wake; second startup skipped backfills; human answer completed the run');
  });
});
describe('Reproduction run-status: one saved status for every reader', () => {
const scope10 = fixtureScope10();


  it('saves the status at start, on each move and at every ending, and every live check agrees', async () => {
    await scope10.everyEnding();
    console.log('Demonstrated run-status: start, handoff, done, failed, deadline and cancel each saved one status that every reader and live check returned');
  });


  it('fills a missing or legacy saved status from the run itself and drops the retired flag', async () => {
    const runs = await scope10.everyEnding();
    const live = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(live);
    const all = [...Object.values(runs), live];
    // Legacy start cards: no saved status, or a stale `active` written by an older release.
    await database.query(`UPDATE messages SET card=card-'runStatus' || '{"active":true}'::jsonb WHERE id=ANY($1::text[])`, [[runs.done, runs.deadline, live]]);
    await database.query(`UPDATE messages SET card=card || '{"active":true}'::jsonb WHERE id=$1`, [runs.failed]);
    await database.query(`UPDATE messages SET card=card-'runStatus' WHERE id=$1`, [runs.cancelled]);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(5);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(0);
    await scope10.expectStatus(runs.done, 'done');
    await scope10.expectStatus(runs.failed, 'failed');
    await scope10.expectStatus(runs.deadline, 'failed');
    await scope10.expectStatus(runs.cancelled, 'abandoned');
    await scope10.expectStatus(live, 'live');
    expect((await database.query(`SELECT 1 FROM messages WHERE id=ANY($1::text[]) AND card ? 'active'`, [all])).rowCount).toBe(0);
  });


  it('re-arms a live run timer lost after deploy on every boot, exactly once', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    const timers = async () => (await database.query<{ id: string; timer: string }>(
      `SELECT id,workflow_run->>'timer' timer FROM agent_schedules WHERE workflow_run->>'runId'=$1 ORDER BY timer`, [runId],
    )).rows;
    const armed = await timers();
    await migrateData(database);
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='step'`, [runId]);
    await migrateData(database);
    await migrateData(database);
    expect(await timers()).toEqual(armed);
    console.log('Demonstrated run-timers: a step timer deleted after the one-time backfills ran was re-armed once by the next boot');
  });


  it('reads live runs through a partial workflow index on the saved status or start cards', async () => {
    await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await database.query(`SET enable_seqscan=off`);
    try {
      const plan = async (sql: string) => JSON.stringify(
        (await database.query<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]?.['QUERY PLAN']);
      expect(await plan(`SELECT id FROM messages WHERE room_id='${ROOM}' AND card_type='workflow-handoff'
        AND ${workflowRunIsLiveSql('card')} AND card->>'workflowSlug'='gated'`)).toContain('messages_workflow_run_live_idx');
      // An unscoped status sweep can use either partial index. The new start
      // index also contains exactly the start cards this predicate requests;
      // the Room-scoped check above still proves the saved-live index is used.
      expect(await plan(`SELECT id FROM messages WHERE card_type='workflow-handoff' AND id=card->>'runId'
        AND ${workflowRunIsLiveSql('card')}`)).toMatch(/messages_workflow_run_(live|start)_idx/);
      expect(await plan(`SELECT id FROM messages WHERE card_type='workflow-handoff'
        AND ${workflowRunStatusUnsavedSql('card', 'id')}`)).toContain('messages_workflow_run_status_backfill_idx');
    } finally {
      await database.query(`SET enable_seqscan=on`);
    }
  });
});
describe('workflow timeout recovery reproductions', () => {
const scope11 = fixtureScope11();


  it('Reproduction wf-1: declared timeout accepts reason without vault_reference, preserving success validation', async () => {
    const { runId } = await scope11.signupRun();
    const command = await commandFor(WORKER_A);
    await expect(handoff(database, command, { runId, outcome: 'ready', contents: { reason: 'No key' } }))
      .rejects.toThrow('vault_reference is required');
    await expect(handoff(database, command, { runId, outcome: 'unknown', contents: { reason: 'No key' } }))
      .rejects.toThrow('invalid outcome');
    for (const contents of [{}, { reason: '' }, { reason: 42 }, { reason: 'x'.repeat(501) }, { reason: 'No key', extra: 'x'.repeat(16384) }, null]) {
      await expect(handoff(database, command, { runId, outcome: 'timeout', contents })).rejects.toThrow();
    }
    await expect(handoff(database, command, { runId, outcome: 'timeout',
      contents: { reason: 'Provider key does not exist' } })).resolves.toMatchObject({ state: 'recover' });
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'recover' });
  });


  it('Reproduction wf-2: directed recovery rebinds maker at owner gate without allowing agent gate answers', async () => {
    const { runId } = await scope11.signupRun();
    await handoff(database, await commandFor(WORKER_A), {
      runId, outcome: 'blocked', contents: { reason: 'Provider signup exhausted' },
    });
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'recover' });
    const directed = await adminCommand();
    await expect(assignWorkflowRole(database, directed, { runId, role: 'maker', targetAgentId: WORKER_B }))
      .resolves.toMatchObject({ state: 'recover' });
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ state: 'recover', boundAgentId: APPROVER });
    await expect(assignWorkflowRole(database, directed, { runId, role: 'missing', targetAgentId: WORKER_B }))
      .rejects.toThrow('role');
    await expect(handoff(database, await commandFor(APPROVER), {
      runId, outcome: 'retry', contents: { decision: 'retry' },
    })).rejects.toThrow();
    await answerGate(runId, 'retry');
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'signup_stills', boundAgentId: WORKER_B });
    await expect(handoff(database, await commandFor(WORKER_B), {
      runId, outcome: 'ready', contents: { vault_reference: 'vault://provider/key' },
    })).resolves.toMatchObject({ status: 'done' });
  });
});
