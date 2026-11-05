import { cornerKindSql, createHash, randomBytes, describe, expect, it, validateCornerWorkflow, migrate, describedWorkflow, PhoneService, DaemonService, LiveHub, advanceCorner, CORNER_LIFECYCLE_CONTRACT, CORNER_LIFECYCLE_SLUG, cornerMergeGate, deleteStoredCornerWorkflows, createAgentCommand, CORNER_LIFECYCLE_CARD_TYPE, cornerOwnerSql, getWorkflowRun, liveWorkflowRun, saveWorkflow, startWorkflow, workflowRunLockKey, RecordingDatabase, H, A, B, W, R, db, phone, daemon, github, githubRollupState, githubHead, githubApp, implementersMerge, derivedWorker, cards, currentState, commissioned, brief, open, claim, pushToCorner, greenHead, redHead, commands, result, SHA, BADGES, OPEN_CLOSE_BADGES, branchOf, reasons, projected, inReview, approve, approved, mergedWebhook, say, revise, F, fallback, rootFixture, fixtureScope2, fixtureScope10, fixtureScope11, type CommandRow } from './corner-lifecycle.test-support.js';

describe('the corner lifecycle contract itself', () => {
  it('validates against the shared workflow-contract schema', () => {
    expect(validateCornerWorkflow(CORNER_LIFECYCLE_CONTRACT)).toBeNull();
  });


  it('is never stored as a Workspace workflow, not even by creating a Workspace', async () => {
    const { id } = await rootFixture.phone.execute('createWorkspace', { name: 'Fresh' }, H);
    expect(
      (await rootFixture.db.query(`SELECT 1 FROM workspace_skills WHERE slug=$1`, [CORNER_LIFECYCLE_SLUG])).rowCount,
    ).toBe(0);
    await rootFixture.db.query(`DELETE FROM workspaces WHERE id=$1`, [id]);
  });


  it('migration deletes the copy older servers seeded, with its versions, and keeps a saved corner workflow', async () => {
    const seeded = '33333333-3333-4333-8333-333333333333';
    await rootFixture.db.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,$3,'Corner lifecycle','active',2,2,$4,'','',NULL,'workflow')`,
      [seeded, W, CORNER_LIFECYCLE_SLUG, R],
    );
    for (const version of [1, 2])
      await rootFixture.db.query(
        `INSERT INTO workspace_skill_versions
           (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
            repository,target_commit,path,extractor_version,model)
         VALUES($1,$2,'{}',$3,NULL,$4,'','',NULL,'corner-workflow-v1','n/a')`,
        [seeded, version, String(version).repeat(64), ['system:corner-workflow-seed']],
      );
    expect(await deleteStoredCornerWorkflows(rootFixture.db)).toBe(1);
    expect((await rootFixture.db.query(`SELECT 1 FROM workspace_skills WHERE id=$1`, [seeded])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM workspace_skill_versions WHERE skill_id=$1`, [seeded])).rowCount).toBe(0);

    const saved = '44444444-4444-4444-8444-444444444444';
    await rootFixture.db.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,$3,'Mine','active',1,1,$4,'','',NULL,'workflow')`,
      [saved, W, CORNER_LIFECYCLE_SLUG, R],
    );
    await rootFixture.db.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,path,extractor_version,model)
       VALUES($1,1,'{}',$2,NULL,$3,'','',NULL,'workflow-save','n/a')`,
      [saved, 'a'.repeat(64), ['m']],
    );
    expect(await deleteStoredCornerWorkflows(rootFixture.db)).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM workspace_skills WHERE id=$1`, [saved])).rowCount).toBe(1);
    await rootFixture.db.query(`DELETE FROM workspace_skills WHERE id=$1`, [saved]);
  });
});
describe.each([
  ['with no stored corner workflow', false],
  ['with a stale stored corner workflow an older server seeded', true],
])('%s, corners work exactly as before', (_name, stored) => {
const scope2 = fixtureScope2(_name, stored);


  it('a code corner opens, advances implement -> checks -> review -> landed, without appearing on the workflow run page', async () => {
    const cornerId = await open('owner/widgets');
    expect(await currentState(cornerId)).toBe('implement');
    expect(await projected(cornerId)).toBe('implement');
    const badges = [await scope2.badge(cornerId)];
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await pushToCorner(cornerId, SHA);
    expect(await currentState(cornerId)).toBe('checks');
    badges.push(await scope2.badge(cornerId));
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('review');
    badges.push(await scope2.badge(cornerId));
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    // A yes keeps the run in review; the implementer is woken to merge.
    expect(await currentState(cornerId)).toBe('review');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'approved', toState: 'review' }),
    );
    badges.push(await scope2.badge(cornerId));
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(1);
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('landed');
    expect(await projected(cornerId)).toBe('landed');
    badges.push(await scope2.badge(cornerId, true));
    expect(badges).toEqual(BADGES);
    // The cards name no workflow and no version.
    for (const card of await cards(cornerId)) {
      expect(card).not.toHaveProperty('workflowSlug');
      expect(card).not.toHaveProperty('workflowVersion');
    }

    await expect(rootFixture.phone.execute('readWorkflowRun', { roomId: cornerId, runId: cornerId }, H))
      .rejects.toThrow('workflow run not found');
    expect((await rootFixture.phone.execute('listRoomWorkflowRuns', { roomId: cornerId }, H)).workflows).toEqual([]);
  });


  it('a corner opens on implement and closes', async () => {
    const cornerId = await open();
    expect(await currentState(cornerId)).toBe('implement');
    const opened = await scope2.badge(cornerId);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('closed');
    expect(await projected(cornerId)).toBe('closed');
    expect([opened, await scope2.badge(cornerId, true)]).toEqual(OPEN_CLOSE_BADGES);
    await expect(rootFixture.phone.execute('readWorkflowRun', { roomId: cornerId, runId: cornerId }, H))
      .rejects.toThrow('workflow run not found');
  });
});
describe('lifecycle wording in agent conversations', () => {
  it('Reproduction C1 R1: opening a corner does not announce a workflow', async () => {
    const cornerId = await open('owner/widgets');
    const conversation = await rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId }, A);
    const start = conversation.items.find((message) => message.id === cornerId);
    expect(start).toBeDefined();
    expect(start!.body).toBe('@system opened corner');
    expect(conversation.items.every((message) => message.systemEvent?.kind !== 'workflow-handoff')).toBe(true);
    const persisted = await rootFixture.db.query<{ card_type: string; seq: string }>(
      `SELECT card_type,card->>'seq' seq FROM messages WHERE id=$1`, [cornerId],
    );
    expect(persisted.rows).toEqual([{ card_type: 'corner-workflow-handoff', seq: '0' }]);
    console.log(`Reproduction C1 R1 Demonstrated: open corner → agent conversation says ${start!.body}, with no workflow event kind`);
  });
});
describe('corner lock', () => {
  it('persists the human toggle, refuses agent close, and allows close after unlocking', async () => {
    const cornerId = await open();
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLocked).toBe(false);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, H);
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLocked).toBe(true);
    const before = await commands(A, cornerId);
    await expect(rootFixture.daemon.execute('archiveCorner', { cornerId }, A)).rejects.toThrow(/corner is locked/);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]?.archived_at).toBeNull();
    expect(await commands(A, cornerId)).toEqual(before);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: false }, H);
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLocked).toBe(false);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('closed');
  });


  it('allows a person to close a locked corner and rejects agents changing the lock', async () => {
    const cornerId = await open();
    await expect(rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, A)).rejects.toThrow(/access denied/);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, H);
    await expect(rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: false }, A)).rejects.toThrow(/access denied/);
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(await currentState(cornerId)).toBe('closed');
  });


  it('Reproduction HEADER-STATE-6: locked merge keeps the corner live and permits a later human close', async () => {
    const cornerId = await open('owner/widgets');
    const sha = 'd'.repeat(40);
    await greenHead(cornerId, 7, sha);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, H);
    const assignmentRows = async () => (await rootFixture.db.query(`SELECT id,state FROM agent_commands WHERE room_id=$1 ORDER BY id`, [cornerId])).rows;
    const before = await assignmentRows();
    await mergedWebhook(cornerId, 7, sha);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]?.archived_at).toBeNull();
    expect(await assignmentRows()).toEqual(before);
    expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).state).not.toBe('archived');
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLifecycle?.pr).toBeUndefined();
    expect(await currentState(cornerId)).toBe('implement');
    expect(await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).toMatchObject({ closeRequested: false, archived: false });
    expect((await rootFixture.phone.readCorners(R, H))!.corners.find(c => c.corner.id === cornerId)!.state).not.toBe('archived');
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1
      AND card->>'type'='corner-complete' AND card->>'cornerId'=$2
      AND card->>'sourceMessageId' IS NULL`, [R, cornerId])).rowCount).toBe(0);
    const mergedNoteId = createHash('sha256').update(
      `beeline:${cornerId}:github:pull-request:merged:https://github.com/owner/widgets/pull/7`,
    ).digest('hex');
    const mergedNote = () => rootFixture.db.query(`SELECT id,card,system_event->>'kind' kind FROM messages
      WHERE room_id=$1 AND card_type='github-corner-note' AND id=$2`, [cornerId, mergedNoteId]);
    expect((await mergedNote()).rows).toEqual([{ id: mergedNoteId, card: null, kind: 'merged' }]);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
    await rootFixture.github.prChecksStatus({ cornerId, pullRequest: 7 });
    expect((await mergedNote()).rows).toEqual([{ id: mergedNoteId, card: null, kind: 'merged' }]);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]?.archived_at).toBeNull();
    await new PhoneService(rootFixture.db, 'http://test', rootFixture.github).execute('requestCornerClose', { roomId: cornerId }, H);
    expect(rootFixture.githubApp.closePullRequest).not.toHaveBeenCalled();
    expect(await currentState(cornerId)).toBe('closed');
  });
});
describe('bookkeeping cards never appear in the corner conversation a human reads', () => {
  it('readRoom shows the real conversation but no workflow-handoff card, through open, checks, and review', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 21, '5'.repeat(40));
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 21, '6'.repeat(40));

    // Confirms the bookkeeping actually ran (otherwise this test would prove
    // nothing) before asserting none of it is visible.
    const recorded = await cards(cornerId);
    expect(recorded.length).toBeGreaterThan(3);

    // The exact reproduction the review used: a real `PhoneService.readRoom`
    // call, the function that serves the mobile/desktop client.
    const view = await rootFixture.phone.readRoom(cornerId, H);
    expect(view).not.toBeNull();
    for (const message of view!.messages) {
      expect(message.text).not.toMatch(/started workflow|handed off/);
    }
    const raw = await rootFixture.db.query<{ count: string }>(
      `SELECT count(*)::text count FROM messages WHERE room_id=$1 AND card_type=$2`,
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
    );
    // The rows genuinely exist (this isn't "nothing was written") — they are
    // simply excluded from what a human reads.
    expect(Number(raw.rows[0]?.count)).toBe(recorded.length);
    expect(view!.messages.map((message) => message.id)).not.toEqual(
      expect.arrayContaining(
        (
          await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card_type=$2`, [
            cornerId,
            CORNER_LIFECYCLE_CARD_TYPE,
          ])
        ).rows.map((row) => row.id),
      ),
    );
  });
});
describe('a corner opens onto implement (row 1-3)', () => {
  it('a repository corner opens straight onto implement', async () => {
    const cornerId = await open('owner/widgets');
    expect(await cards(cornerId)).toEqual([
      expect.objectContaining({ toState: 'opened' }),
      expect.objectContaining({ fromState: 'opened', outcome: 'opened', toState: 'implement' }),
    ]);
  });


  it('has one opening edge, and no investigate, no_code_work or upgrade_to_code state', () => {
    expect(CORNER_LIFECYCLE_CONTRACT.handoffs.opened).toMatchObject({
      on: { opened: 'implement' },
    });
    const states = Object.keys(CORNER_LIFECYCLE_CONTRACT.handoffs);
    expect(states).not.toContain('investigate');
    expect(states).not.toContain('no_code_work');
    expect(states).not.toContain('upgrade_to_code');
  });
});
describe('a person-opened corner in a repository Room', () => {
  it('returns the first corner when a timed-out open retries with the same phone id', async () => {
    const cornerId = '6f1d8c2a-4b3e-4f5a-9c7d-2e8b1a0f3c4d';
    const open = () =>
      rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Retry-safe', cornerId }, H);
    expect(await open()).toEqual({ id: cornerId });
    expect(await open()).toEqual({ id: cornerId });
    expect((await rootFixture.db.query(`SELECT count(*)::int n FROM rooms WHERE parent_id=$1 AND name='Retry-safe'`, [R]))
      .rows[0]).toEqual({ n: 1 });
    expect(await cards(cornerId)).toHaveLength(2);
    await expect(
      rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Bad-id', cornerId: 'not-a-uuid' }, H),
    ).rejects.toThrow('corner id must be a UUID');
  });

  it('NO-SWAP: a person tagging another agent assigns it without stopping the running one', async () => {
    const { id: cornerId } = await rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Swap-widget' }, H);
    await say(cornerId, '@hoots fix the widget');
    const [working] = await commands(A, cornerId);
    await rootFixture.daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: working!.id, generationId: 'g1' }, A);
    await rootFixture.daemon.execute('postAgentTurnReceipt', { roomId: cornerId, requestId: working!.turnRequestId,
      generationId: 'g1', agentId: A, status: 'working' }, A);

    await say(cornerId, '@goosy take this over');
    expect(await derivedWorker(cornerId)).toBe(B);
    expect((await rootFixture.db.query(`SELECT action,reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2
      AND state='pending'`, [cornerId, A])).rows).toEqual([]);
    expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
      [cornerId, A, working!.turnRequestId])).rows).toEqual([{ status: 'working' }]);
    console.log('NO-SWAP Demonstrated: the tagged agent became the worker; the running agent kept its turn and got no stop.');
  });

  it('opens on implement with no lane, and the first tagged agent owns it and drives it to checks', async () => {
    const { id: cornerId } = await rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Fix-widget' }, H);
    expect(await cards(cornerId)).toEqual([
      expect.objectContaining({ toState: 'opened' }),
      expect.objectContaining({ fromState: 'opened', outcome: 'opened', toState: 'implement' }),
    ]);
    expect(await projected(cornerId)).toBe('implement');
    const columns = await rootFixture.db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='corner_facts' AND column_name='lane'`,
    );
    expect(columns.rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id,${cornerKindSql('corner_id')} kind FROM corner_facts WHERE corner_id=$1`, [cornerId]))
      .rows[0]).toEqual({ owner_agent_id: null, kind: 'human' });

    // The first agent a person tags owns the corner; a later tag moves only the implementer.
    await say(cornerId, '@hoots fix the widget');
    expect((await rootFixture.db.query(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`, [cornerId]))
      .rows[0]).toEqual({ owner_agent_id: A });
    expect(await derivedWorker(cornerId)).toBe(A);
    await say(cornerId, '@goosy take this over');
    expect((await rootFixture.db.query(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`, [cornerId]))
      .rows[0]).toEqual({ owner_agent_id: A });
    expect(await derivedWorker(cornerId)).toBe(B);

    // A push on the corner's branch is matched by its prefix and moves the run to checks.
    await rootFixture.github.processWebhook('push', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      ref: `refs/heads/${branchOf(cornerId)}`,
      after: SHA,
      commits: [{}],
      pusher: { name: 'goosy' },
    });
    expect(await currentState(cornerId)).toBe('checks');
  });
});
describe('checks dispatch (rows 6-8)', () => {
  it('a push records implement -> checks', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.github.processWebhook('push', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      ref: `refs/heads/${branchOf(cornerId)}`,
      after: '1'.repeat(40),
      commits: [{}],
      pusher: { name: 'hoots' },
    });
    expect(await currentState(cornerId)).toBe('checks');
  });


  it('a failing check sends it back to implement', async () => {
    const cornerId = await open('owner/widgets');
    await redHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('implement');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'checks', outcome: 'failing', toState: 'implement' }),
    );
  });


  it('a passing check with a configured reviewer moves to review', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
  });


  it('a passing check with no configured reviewer wakes the implementer to arrange review', async () => {
    const cornerId = await open('owner/widgets');
    const before = await reasons(cornerId, A);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'checks', outcome: 'no_reviewer', toState: 'review' }),
    );
    expect(await reasons(cornerId, A)).toEqual([...before, 'corner_review_needed']);
    expect(await reasons(cornerId, B)).toEqual([]);
    const waiting = (await rootFixture.db.query<{ text: string; card: unknown }>(
      `SELECT text,card FROM messages WHERE room_id=$1 AND text LIKE '%needs to approve%'`, [cornerId],
    )).rows;
    expect(waiting).toEqual([]);
  });


  it('an explicit decision report goes privately to the commander, without a human tag', async () => {
    const cornerId = await open('owner/widgets');
    const [work] = await commands(A, cornerId);
    await claim(work!);
    await rootFixture.daemon.execute('report', { status: 'needs_decision', roomId: cornerId, requestId: work!.turnRequestId,
      generationId: 'g1', text: 'needs-decision: decide whether to continue' }, A);
    expect((await commands(A, R)).some(c => c.reason === 'report' && c.source.body.includes('needs-decision:'))).toBe(true);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text='needs-decision: decide whether to continue'`)).rowCount).toBe(0);
  });


  it('the reviewer role is never pinned to a real agent id, so a mid-corner reassignment is recorded correctly next time (finding 1)', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
    // The bound identity is a literal marker, never Goosy's own agent id —
    // the generic engine's own handoff() authorization can never match it,
    // and nothing here needs updating when the parent Room's reviewer changes.
    const startCard = (await cards(cornerId))[0];
    expect((startCard as unknown as { roleBindings: Record<string, string> }).roleBindings.reviewer).toBe(
      'live:parent.reviewer_agent_id',
    );
    // A review that ends without a PASS leaves it in review...
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Review complete: please fix the race condition.');
    expect(await currentState(cornerId)).toBe('review');
    // ...the parent Room's reviewer is reassigned to itself (the only other
    // agent identity this fixture has) while the corner is mid-flight...
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    // ...and the NEXT green head still resolves checks -> review correctly,
    // proving the live path (not anything recorded at start) drives dispatch.
    await greenHead(cornerId, 1, '2'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
  });
});
describe('the run lock (a push transition can race a close or another push)', () => {
  it('takes the run lock as the very first statement, before reading the run current state', async () => {
    const cornerId = await open('owner/widgets');
    const recording = new RecordingDatabase(rootFixture.db);
    await advanceCorner(recording, cornerId, { kind: 'push', headSha: '1'.repeat(40), contents: {} });
    expect(recording.calls[0]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
      values: [workflowRunLockKey(cornerId)],
    });
    const readIndex = recording.calls.findIndex((call) => call.sql.includes('FROM messages'));
    expect(readIndex).toBeGreaterThan(0);
    // The transition still actually happened — this proves the lock, not a no-op.
    expect(await currentState(cornerId)).toBe('checks');
  });


  it('uses the same lock key format the generic workflow engine uses, so a fresh push transaction and a concurrent close serialize against each other', async () => {
    const cornerId = await open('owner/widgets');
    // Simulate the exact race the review found: a push transition's read and
    // write used to be two independent, unlocked round trips. Firing the
    // real push-triggered transition and a real close "concurrently" against
    // PGlite's single connection (which serializes everything anyway, so this
    // proves ordering/correctness, not true concurrency — see workflow-runs
    // .test.ts's own documented limit for the same caveat) must still leave
    // the bookkeeping's own `seq` sequence internally consistent: no two
    // cards at the same seq, and the last one recorded is a real terminal.
    await Promise.all([
      advanceCorner(rootFixture.db, cornerId, { kind: 'push', headSha: '1'.repeat(40), contents: {} }),
      advanceCorner(rootFixture.db, cornerId, { kind: 'closed' }),
    ]);
    const seqs = (await cards(cornerId)).map((card) => (card as unknown as { seq: number }).seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
describe('review dispatch and the fix loop cap (row 9)', () => {
const scope10 = fixtureScope10();


  it("an approved review records review -> review and wakes nobody to merge", async () => {
    const cornerId = await scope10.toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId, headSha: '7'.repeat(40) }, B);
    await result(review!, 'Review complete: approved, merge it.');
    expect(await currentState(cornerId)).toBe('review');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'approved', toState: 'review' }),
    );
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });


  it('PASS-LANDS: a reviewer PASS on a green head lands the PR at once', async () => {
    const cornerId = await scope10.toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    rootFixture.githubHead = '7'.repeat(40);
    rootFixture.githubRollupState = 'passed';
    const landing = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, id => rootFixture.github.landCorner(id));
    Object.assign(landing, { github: { assertCornerReviewerNotAuthor: async () => {} } });
    await expect(landing.execute('approveCornerMerge', { cornerId, headSha: '7'.repeat(40) }, B))
      .resolves.toMatchObject({ status: 'approved' });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
    console.log('PASS-LANDS Demonstrated: the reviewer PASS reached landCorner with no implementer merge_corner turn.');
  });


  it('a review that ends without a PASS records nothing and stays in review', async () => {
    const cornerId = await scope10.toReview();
    const before = await cards(cornerId);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Review complete: please fix the race condition.');
    expect(await currentState(cornerId)).toBe('review');
    expect(await cards(cornerId)).toEqual(before);
    expect(await reasons(cornerId, A)).not.toContain('corner_review');
  });


  it('a reviewer privately orders repairs from its corner on a green head and it stays in review', async () => {
    const cornerId = await scope10.toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!, 'review-generation');
    await rootFixture.daemon.execute('order', { roomId: cornerId, requestId: review!.turnRequestId,
      generationId: 'review-generation', address: cornerId, text: 'Fix the race condition' }, B);
    expect((await commands(A, cornerId)).some(c => c.reason === 'order')).toBe(true);
    expect(await currentState(cornerId)).toBe('review');
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId, headSha: '7'.repeat(40) }, B);
    // The PASS is landed by the server, not handed to the implementer.
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });
});
describe('landing and closing from any state (finding 3, implicit edges)', () => {
const scope11 = fixtureScope11();

  it('the merge webhook lands the corner even while it is still mid-review', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 9, '9'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
    await rootFixture.github.processWebhook('pull_request', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'closed',
      pull_request: {
        number: 9,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/9',
        head: { ref: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`, sha: '9'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-01-01T00:00:00Z',
        commits: 1,
        changed_files: 1,
      },
      sender: { login: 'octocat' },
    });
    const all = await cards(cornerId);
    expect(all.at(-1)).toEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'landed', toState: 'landed', status: 'done' }),
    );
  });


  it('the merge webhook cancels the reviewer\'s still-pending review command, not just the implementer\'s', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 9, '9'.repeat(40));
    const [review] = await commands(B, cornerId);
    expect(review).toBeDefined();
    await rootFixture.github.processWebhook('pull_request', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'closed',
      pull_request: {
        number: 9,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/9',
        head: { ref: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`, sha: '9'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-01-01T00:00:00Z',
        commits: 1,
        changed_files: 1,
      },
      sender: { login: 'octocat' },
    });
    expect(
      (await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [review!.id])).rows[0]!
        .state,
    ).toBe('cancelled');
  });


  it('closing an untouched corner lands it on closed from implement', async () => {
    const cornerId = await open();
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('closed');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'implement', outcome: 'closed', toState: 'closed', status: 'abandoned' }),
    );
  });


  it('an agent archiving its corner cancels a reviewer\'s still-pending review command', async () => {
    const cornerId = await inReview();
    const [review] = await commands(B, cornerId);
    expect(review).toBeDefined();
    await rootFixture.github.closeCornerPullRequest(cornerId);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(
      (await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [review!.id])).rows[0]!
        .state,
    ).toBe('cancelled');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND action IN ('input','resume') AND state IN ('pending','claimed')`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1
      AND status='working'`, [cornerId])).rowCount).toBe(0);
  });


  it('a human close request lands whatever state the corner is in', async () => {
    const cornerId = await open('owner/widgets');
    expect((await commands(A, cornerId)).length).toBeGreaterThan(0);
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(await currentState(cornerId)).toBe('closed');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND action IN ('input','resume') AND state IN ('pending','claimed')`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1
      AND status='working'`, [cornerId])).rowCount).toBe(0);
  });


  it.each(['close', 'merge'] as const)('removes corner wake sources on %s and preserves the live Room (Reproduction corner-wake-cleanup)', async (path) => {
    const cornerId = path === 'close' ? await open() : await inReview();
    const scheduleId = await scope11.seedWakeSources(cornerId);
    const liveScheduleId = await scope11.seedWakeSources(R);
    const liveSubscriptions = (await rootFixture.db.query(`SELECT * FROM agent_subscriptions WHERE room_id=$1 ORDER BY id`, [R])).rows;
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    if (path === 'close') await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    else await mergedWebhook(cornerId, 7, SHA);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0].archived_at).not.toBeNull();
    await scope11.expectWakeSources(cornerId, 0);
    await scope11.expectWakeSources(R, 1);
    expect((await rootFixture.db.query(`SELECT * FROM agent_subscriptions WHERE room_id=$1 ORDER BY id`, [R])).rows).toEqual(liveSubscriptions);
    expect((await rootFixture.db.query(`SELECT released_at IS NOT NULL released FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]!.released).toBe(true);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedule_occurrences WHERE schedule_id=$1`, [scheduleId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedule_occurrences WHERE schedule_id=$1`, [liveScheduleId])).rowCount).toBe(1);
  });


  it('release migration removes existing archived corner wakes and preserves live wakes', async () => {
    const cornerId = await open();
    const liveCornerId = await open();
    await scope11.seedWakeSources(cornerId);
    await scope11.seedWakeSources(liveCornerId);
    await scope11.seedWakeSources(R);
    await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    await rootFixture.db.query(`DELETE FROM workflow_backfills WHERE name='archived-corner-wakes-v1'`);
    await migrate(rootFixture.db);
    await migrate(rootFixture.db);
    await scope11.expectWakeSources(cornerId, 0);
    await scope11.expectWakeSources(liveCornerId, 1);
    await scope11.expectWakeSources(R, 1);
  });


  it('a human close request abandons a live saved workflow run inside the corner', async () => {
    const cornerId = await open();
    const starter = { room_id: cornerId, agent_id: A } as CommandRow;
    await saveWorkflow(rootFixture.db, starter, { contract: describedWorkflow({
      version: 1, name: 'corner-chore', description: 'One step inside a corner', roles: ['worker'], start: 'work',
      handoffs: {
        work: { role: 'worker', requires: ['note'], on: { done: 'finished', timeout: 'failed' }, timeoutSeconds: 3600 },
        finished: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      },
    }) });
    const { runId } = await startWorkflow(rootFixture.db, starter, { name: 'corner-chore', roleBindings: { worker: A } });
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('live');
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('abandoned');
    expect(await liveWorkflowRun(rootFixture.db, cornerId, 'corner-chore')).toBeUndefined();
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId])).rowCount).toBe(0);
    console.log('Demonstrated corner-close-run: closing the corner saved the saved workflow run inside it as abandoned and removed its timers');
  });


  it('a GitHub merge abandons a live saved workflow run and its timers inside the corner', async () => {
    const cornerId = await inReview();
    const starter = { room_id: cornerId, agent_id: A } as CommandRow;
    await saveWorkflow(rootFixture.db, starter, { contract: describedWorkflow({
      version: 1, name: 'corner-chore', description: 'One step inside a corner', roles: ['worker'], start: 'work',
      handoffs: {
        work: { role: 'worker', requires: ['note'], on: { done: 'finished', timeout: 'failed' }, timeoutSeconds: 3600 },
        finished: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      },
    }) });
    const { runId } = await startWorkflow(rootFixture.db, starter, { name: 'corner-chore', roleBindings: { worker: A } });
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('live');
    await mergedWebhook(cornerId, 7, SHA);
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('abandoned');
    expect(await liveWorkflowRun(rootFixture.db, cornerId, 'corner-chore')).toBeUndefined();
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId])).rowCount).toBe(0);
    expect(await currentState(cornerId)).toBe('landed');
    await mergedWebhook(cornerId, 7, SHA);
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('abandoned');
  });


  it('never posts a second terminal card for an already-landed corner', async () => {
    const cornerId = await open();
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    const before = await cards(cornerId);
    // A retried merge webhook or close request must not re-terminate an
    // already-closed run.
    expect(await advanceCorner(rootFixture.db, cornerId, { kind: 'merged', contents: {} })).toEqual({
      state: 'closed',
      accepted: false,
    });
    expect(await cards(cornerId)).toEqual(before);
  });
});


it('review dispatch is immediate and leaves unrelated reviewer work independent', async () => {
  const cornerId = await inReview();
  expect(await currentState(cornerId)).toBe('review');
  expect(await commands(B, cornerId)).toHaveLength(1);
  expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: false, open: false });
  const other = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: B, sourceMessageId: null,
    reason: 'corner_brief', privatePayload: { text: 'Unrelated reviewer fact', authorId: A, fromRoomId: R, kind: 'lifecycle' } });
  const pending = await commands(B, cornerId);
  expect(pending).toHaveLength(2);
  expect(pending.find(command => command.id === other!.id)?.source.body).toBe('Unrelated reviewer fact');
});


it.each(['passing', 'unknown', 'unreachable'])('Reproduction F1-2: ask_human revision resumes %s', async checks => {
  const cornerId = await approved();
  await rootFixture.db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [R, A]);
  await rootFixture.db.query(`UPDATE messages SET card=jsonb_set(card,'{toState}','"ask_human"') WHERE id=(SELECT id FROM messages WHERE room_id=$1 AND card_type='corner-workflow-handoff' ORDER BY (card->>'seq')::int DESC LIMIT 1)`, [cornerId]);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}',$2::jsonb) WHERE corner_id=$1`, [cornerId, JSON.stringify(checks === 'unknown' ? 'unknown' : 'passing')]);
  if (checks === 'unreachable') await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
  const result = await revise(cornerId);
  const state = await currentState(cornerId);
  console.info(`Reproduction F1-2: wrong=ask_human; right=implement; observed=${state}`);
  // A revision never sends the corner to the reviewer: it resumes with the implementer.
  expect(state).toBe('implement');
  expect(await cards(cornerId)).toContainEqual(
    expect.objectContaining({ fromState: 'ask_human', outcome: 'revision_work', toState: 'implement' }),
  );
  expect(result).toMatchObject({ revision: 2, wake: { queued: true, agentId: A } });
  expect(await reasons(cornerId, A)).toContain('corner_brief_revision');
});


it('Reproduction F1-7: opener revises a delegated sibling from its own command', async () => {
  const source = await open('owner/widgets');
  const command = await commissioned(source);
  const input = { roomId: source, requestId: command.turnRequestId, generationId: 'g1', name: 'Delegate-widget', objective: 'Ship the widget', repository: 'owner/widgets', implementer: 'goosy', brief: brief(command.sourceMessageId) };
  const { cornerId } = await rootFixture.daemon.execute('createCorner', input, A);
  await rootFixture.db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [R, B]);
  const result = await rootFixture.daemon.execute('reviseCornerBrief', { roomId: source, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 1, brief: { ...input.brief, spec: 'Corrected widget', change: 'Correct scope' } }, A);
  console.info(`Reproduction F1-7: wrong=revision denied; right=revision 2; observed=${result.revision}`);
  expect(result).toMatchObject({ revision: 2, wake: { queued: true, agentId: B } });
  await fallback(cornerId);
  const outsider = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: F, sourceMessageId: command.sourceMessageId, reason: 'audit' });
  await rootFixture.daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: outsider!.id, generationId: 'g1' }, F);
  // Reach, not role, decides: an agent outside both the corner and its parent Room is refused.
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id IN ($1,$2) AND identity_id=$3`, [cornerId, R, F]);
  await expect(rootFixture.daemon.execute('reviseCornerBrief', { roomId: cornerId, cornerId, requestId: outsider!.turn_request_id, generationId: 'g1', expectedRevision: 2, brief: { ...input.brief, change: 'Unauthorized' } }, F)).rejects.toThrow(/denied/);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
  const unwoken = await rootFixture.daemon.execute('reviseCornerBrief', { roomId: source, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 2, brief: { ...input.brief, spec: 'Saved without a worker', change: 'Keep the revision' } }, A);
  expect(unwoken).toMatchObject({ revision: 3, wake: { queued: false, reason: expect.any(String) } });
  expect((await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId }, A)).revisions[0]!.revision).toBe(3);
});


it('a corner member revises from its own corner and the Room', async () => {
  const cornerId = await open('owner/widgets');
  const command = await commissioned(cornerId);
  const G = '8'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Heir','heir') ON CONFLICT DO NOTHING`, [G]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [G, H]);
  for (const roomId of [null, R])
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [W, roomId, G]);
  const turn = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: G, sourceMessageId: command.sourceMessageId, reason: 'human_tag' });
  await rootFixture.daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: turn!.id, generationId: 'g1' }, G);
  const input = { cornerId, requestId: turn!.turn_request_id, generationId: 'g1', expectedRevision: 1, brief: { ...brief(command.sourceMessageId), spec: 'Heir scope', change: 'Take over' } };
  expect(await rootFixture.daemon.execute('reviseCornerBrief', input, G)).toMatchObject({ revision: 2 });
  await rootFixture.phone.execute('sendRoomMessage', { roomId: R, messageId: randomBytes(32).toString('hex'), text: '@heir revise the brief' }, H);
  const roomTurn = (await rootFixture.daemon.execute('getAgentCommands', { roomId: R }, G)).commands.at(-1)!;
  await claim(roomTurn);
  expect(await rootFixture.daemon.execute('reviseCornerBrief', { ...input, expectedRevision: 2, roomId: R, requestId: roomTurn.turnRequestId }, G))
    .toMatchObject({ revision: 3 });
});


it('Reproduction F1-9: brief history defaults to one revision with a cursor', async () => {
  const cornerId = await open('owner/widgets');
  await revise(cornerId);
  const result = await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId }, A);
  console.info(`Reproduction F1-9: wrong=2 full revisions; right=1 with cursor; observed=${result.revisions.length}`);
  expect(result.revisions.map(r => r.revision)).toEqual([2]);
  expect(result.nextBeforeRevision).toBe(2);
  expect((await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId, beforeRevision: 2 }, A)).revisions[0]!.revision).toBe(1);
  expect((await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId, limit: 20 }, A)).revisions).toHaveLength(2);
  await expect(rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId, limit: 21 }, A)).rejects.toThrow('invalid');
});


it('Reproduction F1-11: exact replay survives implementer departure', async () => {
  const command = await commissioned(R);
  const input = { roomId: R, requestId: command.turnRequestId, generationId: 'g1', idempotencyKey: 'f1-replay', name: 'Delegate-widget', objective: 'Ship widget', repository: 'owner/widgets', implementer: 'goosy', brief: brief(command.sourceMessageId) };
  const first = await rootFixture.daemon.execute('createCorner', input, A);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
  const replay = await rootFixture.daemon.execute('createCorner', input, A);
  console.info(`Reproduction F1-11: wrong=membership refusal; right=original corner; observed=${replay.cornerId}`);
  expect(replay).toEqual(first);
  await expect(rootFixture.daemon.execute('createCorner', { ...input, implementer: 'hoots' }, A)).rejects.toThrow('assignment conflict');
  await expect(rootFixture.daemon.execute('createCorner', { ...input, brief: { ...input.brief, spec: 'Different' } }, A)).rejects.toThrow('assignment conflict');
  await expect(rootFixture.daemon.execute('createCorner', { ...input, idempotencyKey: 'new-call' }, A)).rejects.toThrow('current member');
});
